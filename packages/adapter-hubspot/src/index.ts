import {
  fetchWithRetry, fetchBlobToBundle, richTextFromHtml,
  type Adapter, type AdapterContext, type Schema, type Source, type UdmpRecord, type ObjectDef, type Field, type Relationship,
} from "@udmp/core";

/**
 * HubSpot CRM exporter. Uses a Private App access token (Settings → Integrations → Private Apps)
 * with read scopes: crm.objects.{contacts,companies,deals,tickets}.read, crm.schemas.*.read,
 * crm.objects.owners.read, files, and the engagement read scopes.
 *
 * This adapter demonstrates the *dynamic* schema path: every property, its type and enum
 * options, and every association label are read live from the tenant.
 *
 * Config: { access_token: string, base_url?: string, objects?: string (comma list), blobs?: "true"|"false" }
 */
export interface HubSpotConfig { access_token: string; base_url?: string; objects?: string; blobs?: string }

const BASE = "https://api.hubapi.com";

/** HubSpot object type → UDMP object name and semantic. */
const OBJECTS: Record<string, { name: string; display: string; semantic: string }> = {
  companies: { name: "account", display: "Companies", semantic: "crm.account" },
  contacts: { name: "contact", display: "Contacts", semantic: "crm.contact" },
  deals: { name: "deal", display: "Deals", semantic: "crm.deal" },
  tickets: { name: "ticket", display: "Tickets", semantic: "support.ticket" },
  notes: { name: "note", display: "Notes", semantic: "crm.note" },
  calls: { name: "call", display: "Calls", semantic: "crm.activity" },
  emails: { name: "email", display: "Emails", semantic: "crm.activity" },
  meetings: { name: "meeting", display: "Meetings", semantic: "crm.activity" },
  tasks: { name: "task", display: "Tasks", semantic: "crm.task" },
};
const DEFAULT_OBJECTS = ["companies", "contacts", "deals", "tickets", "notes", "calls", "emails", "meetings", "tasks"];

/** Well-known HubSpot properties that get semantic tags. */
const SEMANTIC_PROPS: Record<string, string> = {
  "companies.name": "common.name", "companies.domain": "crm.account.domain", "companies.industry": "crm.account.industry",
  "companies.numberofemployees": "crm.account.employee_count", "companies.annualrevenue": "crm.account.annual_revenue", "companies.phone": "crm.account.phone",
  "companies.lifecyclestage": "crm.account.lifecycle_stage", "companies.hubspot_owner_id": "common.owner",
  "contacts.email": "crm.contact.email", "contacts.firstname": "crm.contact.first_name", "contacts.lastname": "crm.contact.last_name",
  "contacts.phone": "crm.contact.phone", "contacts.jobtitle": "crm.contact.job_title", "contacts.lifecyclestage": "crm.contact.lifecycle_stage",
  "contacts.hs_lead_status": "common.status", "contacts.hubspot_owner_id": "common.owner",
  "deals.dealname": "common.name", "deals.amount": "crm.deal.amount", "deals.dealstage": "crm.deal.stage", "deals.pipeline": "crm.deal.pipeline",
  "deals.closedate": "crm.deal.close_date", "deals.hs_deal_stage_probability": "crm.deal.probability", "deals.hubspot_owner_id": "common.owner",
  "deals.deal_currency_code": "crm.deal.currency",
  "tickets.subject": "support.ticket.subject", "tickets.hs_pipeline_stage": "support.ticket.status", "tickets.hs_ticket_priority": "support.ticket.priority",
  "tickets.hubspot_owner_id": "support.ticket.assignee", "tickets.content": "common.description",
  "notes.hs_note_body": "crm.note.body", "calls.hs_call_body": "crm.activity.body", "emails.hs_email_text": "crm.activity.body",
  "meetings.hs_meeting_body": "crm.activity.body", "tasks.hs_task_body": "common.description", "tasks.hs_task_subject": "common.title",
  "tasks.hs_task_status": "common.status", "tasks.hs_timestamp": "crm.task.due_at",
};

/** HubSpot property definitions (from /crm/v3/properties/{object}). */
interface HsProperty {
  name: string; label: string; type: string; fieldType: string; description?: string;
  hubspotDefined?: boolean; options?: Array<{ label: string; value: string; displayOrder?: number; hidden?: boolean }>;
  referencedObjectType?: string; calculated?: boolean; modificationMetadata?: { readOnlyValue?: boolean };
}

function mapType(p: HsProperty): Pick<Field, "type" | "enum" | "reference"> {
  if (p.referencedObjectType === "OWNER") return { type: "reference", reference: { object: "owner" } };
  if (p.fieldType === "file") return { type: "attachment" }; // hydrated from the Files API in read()
  switch (p.type) {
    case "number": return { type: p.fieldType === "number" && /amount|revenue|price|value/i.test(p.name) ? "decimal" : "float" };
    case "bool": return { type: "boolean" };
    case "date": return { type: "date" };
    case "datetime": return { type: "datetime" };
    case "enumeration": return {
      type: p.fieldType === "checkbox" ? "array" : "enum",
      enum: { values: (p.options ?? []).map((o) => ({ value: o.value, label: o.label, order: o.displayOrder })), open: true },
    };
    case "object_coordinates": return { type: "geo" };
    case "json": return { type: "json" };
    default:
      return { type: p.fieldType === "html" || /_body$|^content$|hs_email_html/.test(p.name) ? "richtext" : "string" };
  }
}

function safeFieldName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z_]/, "_$&").slice(0, 120);
  return s || "_";
}

function propertyToField(hsObject: string, p: HsProperty): Field {
  const custom = p.hubspotDefined === false || (!p.hubspotDefined && !p.name.startsWith("hs_") && !SEMANTIC_PROPS[`${hsObject}.${p.name}`]);
  const base = safeFieldName(p.name);
  const name = custom && !base.startsWith("cf_") ? `cf_${base}` : base;
  const t = mapType(p);
  const field: Field = {
    name, display_name: p.label, description: p.description || undefined, source_name: p.name, source_type: `${p.type}/${p.fieldType}`,
    is_custom: custom, nullable: true, ...t,
  };
  if (t.type === "array") field.items = { type: "string" };
  const sem = SEMANTIC_PROPS[`${hsObject}.${p.name}`];
  if (sem) field.semantic = sem;
  return field;
}

interface Discovered { hsObject: string; def: ObjectDef; props: HsProperty[]; fieldByProp: Map<string, Field> }

export class HubSpotClient {
  constructor(private cfg: HubSpotConfig, private signal?: AbortSignal) {}
  private get base() { return this.cfg.base_url ?? BASE; }
  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetchWithRetry(url, { headers: { authorization: `Bearer ${this.cfg.access_token}` }, signal: this.signal });
    if (!res.ok) throw new Error(`HubSpot ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchWithRetry(new URL(path, this.base), {
      method: "POST", headers: { authorization: `Bearer ${this.cfg.access_token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: this.signal,
    });
    if (!res.ok) throw new Error(`HubSpot ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
}

function wantedObjects(cfg: HubSpotConfig): string[] {
  return cfg.objects ? cfg.objects.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_OBJECTS;
}

/** Read every property definition and every association type between the wanted objects. */
export async function discoverSchema(client: HubSpotClient, cfg: HubSpotConfig, log: (m: string) => void): Promise<{ schema: Schema; discovered: Map<string, Discovered> }> {
  const want = wantedObjects(cfg);
  const discovered = new Map<string, Discovered>();
  const objects: ObjectDef[] = [];

  // Owners are a separate API, not a CRM object; model them as identity.user.
  objects.push({
    name: "owner", display_name: "Owners", semantic: "identity.user", source_name: "owners", primary_key: "id",
    fields: [
      { name: "id", type: "string", nullable: false }, { name: "email", type: "string", semantic: "identity.user.email" },
      { name: "first_name", type: "string" }, { name: "last_name", type: "string" }, { name: "user_id", type: "string" },
      { name: "archived", type: "boolean" }, { name: "created_at", type: "datetime" }, { name: "updated_at", type: "datetime" },
    ],
  });

  for (const hs of want) {
    const meta = OBJECTS[hs] ?? { name: safeFieldName(hs), display: hs, semantic: `x-hubspot.${safeFieldName(hs)}` };
    const { results } = await client.get<{ results: HsProperty[] }>(`/crm/v3/properties/${hs}`);
    const fieldByProp = new Map<string, Field>();
    const fields: Field[] = [
      { name: "id", type: "string", nullable: false, semantic: "common.id", source_name: "id" },
      { name: "created_at", type: "datetime", semantic: "common.created_at", source_name: "createdAt" },
      { name: "updated_at", type: "datetime", semantic: "common.updated_at", source_name: "updatedAt" },
      { name: "archived", type: "boolean", source_name: "archived" },
      { name: "deleted_at", type: "datetime", semantic: "common.deleted_at", source_name: "archivedAt" },
    ];
    const taken = new Set(fields.map((f) => f.name));
    for (const p of results) {
      const f = propertyToField(hs, p);
      let n = f.name, i = 2;
      while (taken.has(n)) n = `${f.name}_${i++}`;
      f.name = n; taken.add(n);
      fields.push(f); fieldByProp.set(p.name, f);
    }
    const def: ObjectDef = { name: meta.name, display_name: meta.display, semantic: meta.semantic, source_name: hs, primary_key: "id", fields, soft_delete_field: "deleted_at" };
    objects.push(def);
    discovered.set(hs, { hsObject: hs, def, props: results, fieldByProp });
    log(`hubspot: ${hs} → ${meta.name}: ${results.length} properties (${fields.filter((f) => f.is_custom).length} custom)`);
  }

  // Associations: one junction object per (from,to) pair, with the label as an enum.
  const relationships: Relationship[] = [];
  const pairs = new Set<string>();
  for (const a of want) for (const b of want) {
    if (a === b || pairs.has(`${b}|${a}`)) continue;
    let labels: Array<{ typeId: number; label: string | null; category: string }> = [];
    try { labels = (await client.get<{ results: typeof labels }>(`/crm/v4/associations/${a}/${b}/labels`)).results; } catch { continue; }
    if (!labels.length) continue;
    pairs.add(`${a}|${b}`);
    const A = discovered.get(a)!.def.name, B = discovered.get(b)!.def.name;
    const jname = `${A}_${B}`;
    objects.push({
      name: jname, display_name: `${OBJECTS[a]?.display ?? a} ↔ ${OBJECTS[b]?.display ?? b}`, source_name: `associations/${a}/${b}`, primary_key: "id", is_junction: true,
      fields: [
        { name: "id", type: "string", nullable: false },
        { name: `${A}_id`, type: "reference", reference: { object: A }, nullable: false },
        { name: `${B}_id`, type: "reference", reference: { object: B }, nullable: false },
        { name: "label", type: "enum", enum: { values: labels.map((l) => ({ value: String(l.typeId), label: l.label ?? `${l.category.toLowerCase()} (unlabeled)` })), open: true } },
        { name: "category", type: "string" },
      ],
    });
    relationships.push({ name: jname, type: "many_to_many", from: { object: A, field: "id" }, to: { object: B, field: "id" }, through: { object: jname, from_field: `${A}_id`, to_field: `${B}_id` } });
  }
  for (const d of discovered.values()) {
    const ownerField = d.def.fields.find((f) => f.source_name === "hubspot_owner_id");
    if (ownerField) relationships.push({ name: `${d.def.name}_owner`, type: "one_to_many", from: { object: "owner", field: "id" }, to: { object: d.def.name, field: ownerField.name } });
  }
  return { schema: { objects, relationships }, discovered };
}

function convert(f: Field, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw);
  switch (f.type) {
    case "boolean": return s === "true";
    case "float": { const n = Number(s); return Number.isFinite(n) ? n : null; }
    case "decimal": return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
    case "date": return s.length >= 10 ? s.slice(0, 10) : null;
    case "datetime": return /^\d+$/.test(s) ? new Date(Number(s)).toISOString() : s;
    case "array": return s.split(";").filter(Boolean);
    case "richtext": return richTextFromHtml(s);
    case "geo": try { const g = JSON.parse(s); return { lat: Number(g.latitude ?? g.lat), lon: Number(g.longitude ?? g.lon) }; } catch { return null; }
    case "json": try { return JSON.parse(s); } catch { return s; }
    default: return s;
  }
}

interface HsPage { results: Array<{ id: string; createdAt: string; updatedAt: string; archived: boolean; archivedAt?: string; properties: Record<string, string | null> }>; paging?: { next?: { after: string } } }

async function* pageObjects(client: HubSpotClient, d: Discovered, ctx: AdapterContext, after?: string, archived = false): AsyncGenerator<{ rec: UdmpRecord; after?: string }> {
  const props = d.props.map((p) => p.name);
  // The list endpoint caps `properties` by URL length; use the search endpoint with POST for large schemas.
  let cursor = after;
  for (;;) {
    if (ctx.signal?.aborted) throw new Error("aborted");
    let page: HsPage;
    try {
      page = await client.post<HsPage>(`/crm/v3/objects/${d.hsObject}/search`,
        { limit: 200, after: cursor, properties: props, sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }] });
    } catch (e) {
      // Engagement objects (notes, calls...) reject search sorts on hs_object_id in some portals; fall back to the list endpoint.
      if (!/400/.test((e as Error).message)) throw e;
      page = await client.get<HsPage>(`/crm/v3/objects/${d.hsObject}`, { limit: 100, after: cursor, properties: props.slice(0, 300).join(","), archived: String(archived) });
    }
    for (const r of page.results) {
      const rec: UdmpRecord = { id: r.id, created_at: r.createdAt, updated_at: r.updatedAt, archived: r.archived, deleted_at: r.archivedAt ?? null };
      for (const [prop, val] of Object.entries(r.properties ?? {})) {
        const f = d.fieldByProp.get(prop);
        if (f) rec[f.name] = convert(f, val);
      }
      yield { rec, after: page.paging?.next?.after };
    }
    if (!page.paging?.next?.after) return;
    cursor = page.paging.next.after;
  }
}

async function* pageAssociations(client: HubSpotClient, a: Discovered, b: Discovered, A: string, B: string, ctx: AdapterContext): AsyncGenerator<UdmpRecord> {
  // Batch read associations 100 source ids at a time. We re-list A ids cheaply (id only).
  let after: string | undefined;
  for (;;) {
    if (ctx.signal?.aborted) throw new Error("aborted");
    const page = await client.get<{ results: Array<{ id: string }>; paging?: { next?: { after: string } } }>(`/crm/v3/objects/${a.hsObject}`, { limit: 100, after, properties: "hs_object_id" });
    if (page.results.length) {
      const batch = await client.post<{ results: Array<{ from: { id: string }; to: Array<{ toObjectId: number; associationTypes: Array<{ typeId: number; label: string | null; category: string }> }> }> }>(
        `/crm/v4/associations/${a.hsObject}/${b.hsObject}/batch/read`, { inputs: page.results.map((r) => ({ id: r.id })) },
      );
      for (const row of batch.results) for (const t of row.to) for (const at of t.associationTypes)
        yield { id: `${row.from.id}:${t.toObjectId}:${at.typeId}`, [`${A}_id`]: row.from.id, [`${B}_id`]: String(t.toObjectId), label: String(at.typeId), category: at.category };
    }
    if (!page.paging?.next?.after) return;
    after = page.paging.next.after;
  }
}

export const adapter: Adapter<HubSpotConfig> = {
  platform: "hubspot",
  displayName: "HubSpot",
  version: "1.0.0-rc.1",
  _cache: null as unknown,

  async connect(cfg) {
    if (!cfg.access_token) throw new Error("hubspot: access_token is required (UDMP_HUBSPOT_ACCESS_TOKEN or --config access_token=...)");
    const client = new HubSpotClient(cfg);
    const info = await client.get<{ portalId: number; uiDomain?: string; timeZone?: string; dataHostingLocation?: string }>("/account-info/v3/details");
    const source: Source = {
      platform: "hubspot", platform_display_name: "HubSpot", instance_id: `portal_${info.portalId}`,
      instance_url: `https://${info.uiDomain ?? "app.hubspot.com"}/contacts/${info.portalId}`, region: info.dataHostingLocation,
      api_versions: { crm_objects: "v3", crm_properties: "v3", associations: "v4", files: "v3" },
    };
    return source;
  },

  async discover(cfg, ctx) {
    const client = new HubSpotClient(cfg, ctx.signal);
    const { schema, discovered } = await discoverSchema(client, cfg, ctx.log);
    (this as unknown as { _cache: Map<string, Discovered> })._cache = discovered;
    return schema;
  },

  async read(cfg, object, ctx, cursor) {
    const client = new HubSpotClient(cfg, ctx.signal);
    const cache = (this as unknown as { _cache: Map<string, Discovered> | null })._cache ?? (await discoverSchema(client, cfg, ctx.log)).discovered;
    const state = (cursor ?? {}) as { after?: string };
    let last: string | undefined = state.after;

    if (object === "owner") {
      async function* owners(): AsyncGenerator<UdmpRecord> {
        let after: string | undefined;
        for (const archived of [false, true]) {
          after = undefined;
          for (;;) {
            const page: { results: Array<Record<string, unknown>>; paging?: { next?: { after: string } } } = await client.get("/crm/v3/owners", { limit: 500, after, archived: String(archived) });
            for (const o of page.results) yield { id: String(o.id), email: o.email ?? null, first_name: o.firstName ?? null, last_name: o.lastName ?? null, user_id: o.userId != null ? String(o.userId) : null, archived, created_at: o.createdAt ?? null, updated_at: o.updatedAt ?? null };
            if (!page.paging?.next?.after) break;
            after = page.paging.next.after;
          }
        }
      }
      return { records: owners() };
    }

    const d = [...cache.values()].find((x) => x.def.name === object);
    if (d) {
      const self = this;
      async function* records(): AsyncGenerator<UdmpRecord> {
        for await (const { rec, after } of pageObjects(client, d!, ctx, state.after)) {
          // Hydrate file-typed properties (HubSpot stores file ids in string props ending in _file or of fieldType "file").
          for (const p of d!.props) if (p.fieldType === "file" && rec[d!.fieldByProp.get(p.name)!.name] && cfg.blobs !== "false") {
            const fname = d!.fieldByProp.get(p.name)!.name;
            rec[fname] = await self.fetchBlob!(cfg, { url: `${cfg.base_url ?? BASE}/files/v3/files/${rec[fname]}`, hubspot_file_id: rec[fname] }, ctx);
          }
          yield rec;
          last = after;
        }
      }
      return { records: records(), cursor: () => ({ after: last }) };
    }

    // Junction object "<A>_<B>"
    for (const a of cache.values()) for (const b of cache.values()) {
      if (`${a.def.name}_${b.def.name}` !== object) continue;
      return { records: pageAssociations(client, a, b, a.def.name, b.def.name, ctx) };
    }
    throw new Error(`hubspot: unknown object ${object}`);
  },

  async fetchBlob(cfg, ref, ctx) {
    // Files API: resolve a signed download URL, then stream it.
    const client = new HubSpotClient(cfg, ctx.signal);
    try {
      const fileId = ref.hubspot_file_id ?? ref.url.split("/").pop();
      const meta = await client.get<{ id: string; name: string; extension?: string; type?: string; size?: number; url?: string }>(`/files/v3/files/${fileId}`);
      const signed = await client.get<{ url: string }>(`/files/v3/files/${fileId}/signed-url`);
      return fetchBlobToBundle(ctx, { url: signed.url, filename: meta.extension ? `${meta.name}.${meta.extension}` : meta.name, bytes: meta.size });
    } catch (e) {
      return ctx.blob.failed({ source_url: ref.url }, (e as Error).message);
    }
  },
} as Adapter<HubSpotConfig> & { _cache: unknown };

export default adapter;
