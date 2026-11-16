import {
  rewriteReferences, pkOf, primaryKeyFields,
  type Importer, type ImportContext, type ImportResult, type MappingPlan, type ObjectMapping, type FieldMapping, type IdMap,
  type Manifest, type ObjectDef, type Field, type UdmpRecord, type BundleReader, type RichText, type Attachment, type Currency,
} from "@udmp/core";
import { TwentyClient, camelField, labelOf, capitalize, type TwentyConfig, type TwentyObjectMeta, type TwentyFieldMeta } from "./client.js";

export type { TwentyConfig } from "./client.js";
export { TwentyClient } from "./client.js";

const VERSION = "1.0.0-rc.1";
const EXTERNAL_ID = "udmpSourceId";

/** Semantic object tag → Twenty standard object. */
const OBJECTS: Record<string, { plural: string; singular: string; mode: "create" | "lookup" }> = {
  "crm.account": { plural: "companies", singular: "company", mode: "create" },
  "crm.contact": { plural: "people", singular: "person", mode: "create" },
  "crm.lead": { plural: "people", singular: "person", mode: "create" },
  "crm.deal": { plural: "opportunities", singular: "opportunity", mode: "create" },
  "identity.user": { plural: "workspaceMembers", singular: "workspaceMember", mode: "lookup" },
};

/** Semantic field tag → target input path and value transform, per target object. */
interface FieldSpec { target: string; transform?: string; set?: (v: unknown, input: Record<string, unknown>, field: Field) => void }
const money = (path: string) => (v: unknown, input: Record<string, unknown>) => {
  const c = typeof v === "object" && v && "amount" in v ? (v as Currency) : { amount: String(v), code: "USD" };
  const micros = Math.round(Number(c.amount) * 1_000_000);
  if (Number.isFinite(micros)) setPath(input, path, { amountMicros: micros, currencyCode: c.code });
};
const FIELDS: Record<string, Record<string, FieldSpec>> = {
  companies: {
    "common.name": { target: "name" },
    "crm.account.domain": { target: "domainName.primaryLinkUrl", transform: "prefixed with https:// when bare", set: (v, i) => setPath(i, "domainName.primaryLinkUrl", /^https?:\/\//.test(String(v)) ? String(v) : `https://${v}`) },
    "crm.account.employee_count": { target: "employees", set: (v, i) => { const n = Number(v); if (Number.isFinite(n)) i.employees = n; } },
    "crm.account.annual_revenue": { target: "annualRecurringRevenue", transform: "decimal → amountMicros", set: money("annualRecurringRevenue") },
    "crm.account.phone": { target: "phones.primaryPhoneNumber" },
    "crm.account.address": { target: "address.addressStreet1", transform: "string or object → address composite", set: (v, i) => setPath(i, "address.addressStreet1", typeof v === "string" ? v : JSON.stringify(v)) },
    "common.owner": { target: "accountOwnerId", transform: "id map (identity.user → workspace member)" },
    "common.created_at": { target: "createdAt" },
  },
  people: {
    "crm.contact.email": { target: "emails.primaryEmail" },
    "crm.contact.first_name": { target: "name.firstName" },
    "crm.contact.last_name": { target: "name.lastName" },
    "common.name": { target: "name.firstName", transform: "split on first space into firstName/lastName", set: (v, i) => { const [f, ...r] = String(v).split(" "); setPath(i, "name.firstName", f); if (r.length) setPath(i, "name.lastName", r.join(" ")); } },
    "crm.contact.phone": { target: "phones.primaryPhoneNumber" },
    "crm.contact.job_title": { target: "jobTitle" },
    "crm.contact.account": { target: "companyId", transform: "id map (crm.account → company)" },
    "common.created_at": { target: "createdAt" },
  },
  opportunities: {
    "common.name": { target: "name" },
    "crm.deal.amount": { target: "amount", transform: "currency → amountMicros + currencyCode", set: money("amount") },
    "crm.deal.close_date": { target: "closeDate" },
    "crm.deal.account": { target: "companyId", transform: "id map (crm.account → company)" },
    "crm.deal.primary_contact": { target: "pointOfContactId", transform: "id map (crm.contact → person)" },
    "crm.deal.stage": { target: "stage", transform: "uppercased and matched to the target SELECT options; unmatched values go to the JSON note" },
    "common.description": { target: "note:bodyV2.markdown", transform: "richtext → linked Note record" },
    "common.created_at": { target: "createdAt" },
  },
  workspaceMembers: {
    "identity.user.email": { target: "userEmail", transform: "lookup key" },
  },
};
const STAGE_SYNONYMS: Record<string, string> = {
  CLOSEDWON: "CUSTOMER", CLOSED_WON: "CUSTOMER", WON: "CUSTOMER",
  QUALIFIED: "SCREENING", QUALIFIEDTOBUY: "SCREENING", DISCOVERY: "SCREENING",
  APPOINTMENTSCHEDULED: "MEETING", PRESENTATIONSCHEDULED: "MEETING", DEMO: "MEETING",
  DECISIONMAKERBOUGHTIN: "PROPOSAL", CONTRACTSENT: "PROPOSAL", NEGOTIATION: "PROPOSAL",
  OPEN: "NEW", LEAD: "NEW",
};
/** Twenty fields an importer must never write. */
const READ_ONLY = new Set(["id", "updatedAt", "deletedAt", "position", "searchVector", "createdBy"]);
const SIMPLE_TYPES = new Set(["TEXT", "NUMBER", "NUMERIC", "BOOLEAN", "DATE", "DATE_TIME", "RAW_JSON", "SELECT", "MULTI_SELECT", "RATING"]);

function setPath(obj: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] ??= {}) as Record<string, unknown>;
  cur[parts.at(-1)!] = v;
}

function twentyType(f: Field): { type: string; options?: TwentyFieldMeta["options"] } {
  switch (f.type) {
    case "string": case "time": case "duration": return { type: "TEXT" };
    case "integer": case "float": case "decimal": return { type: "NUMBER" };
    case "boolean": return { type: "BOOLEAN" };
    case "date": return { type: "DATE" };
    case "datetime": return { type: "DATE_TIME" };
    case "enum": {
      const vals = f.enum?.values ?? [];
      if (!vals.length) return { type: "TEXT" };
      return { type: "SELECT", options: vals.map((v, i) => ({ value: optionValue(v.value), label: v.label ?? v.value, position: v.order ?? i, color: "gray" })) };
    }
    default: return { type: "RAW_JSON" }; // array, json, geo, currency
  }
}
function optionValue(v: string): string {
  const s = v.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Z]/.test(s) ? s : `V_${s}`;
}
function coerce(f: Field, v: unknown, meta?: TwentyFieldMeta): unknown {
  switch (meta?.type) {
    case "NUMBER": case "NUMERIC": { const n = Number(v); return Number.isFinite(n) ? n : null; }
    case "BOOLEAN": return Boolean(v);
    case "SELECT": { const o = optionValue(String(v)); return meta.options?.some((x) => x.value === o) ? o : undefined; }
    case "MULTI_SELECT": return Array.isArray(v) ? v.map((x) => optionValue(String(x))).filter((o) => meta.options?.some((x) => x.value === o)) : undefined;
    case "TEXT": return typeof v === "string" ? v : JSON.stringify(v);
    case "RAW_JSON": return v;
    default: return v;
  }
}

function ctxLog(ctx?: ImportContext): (m: string) => void { return ctx?.log ?? (() => {}); }

/** A junction object becomes a custom Twenty object with two MANY_TO_ONE relations. */
function junctionTarget(from: { singular: string }, to: { singular: string }): { plural: string; singular: string; fromField: string; toField: string } {
  const singular = `${from.singular}${capitalize(to.singular)}Link`;
  return { plural: `${singular}s`, singular, fromField: `${from.singular}Id`, toField: `${to.singular}Id` };
}

interface Planned { obj: ObjectDef; mapping: ObjectMapping; target?: { plural: string; singular: string }; junction?: { rel: { from: string; to: string; fromField: string; toField: string } } }

export const importer: Importer<TwentyConfig> = {
  platform: "twenty",
  displayName: "Twenty CRM",
  version: VERSION,

  async connect(config) {
    const client = new TwentyClient(config);
    const objects = await client.objects();
    if (!objects.some((o) => o.namePlural === "companies")) throw new Error("connected, but the workspace exposes no `companies` object; is this a Twenty instance?");
    return { platform: "twenty", instance_url: client.base, objects: objects.length };
  },

  async plan(config, manifest, ctx) {
    const client = new TwentyClient(config, ctx?.signal);
    const meta = await client.objects();
    const planned = buildPlan(manifest, meta, true);
    return planned.plan;
  },

  async apply(config, bundle, plan, ctx) {
    const log = ctxLog(ctx);
    const client = new TwentyClient(config, ctx?.signal);
    if (plan.bundle_id !== bundle.manifest.bundle_id) throw new Error(`plan is for bundle ${plan.bundle_id}, but this bundle is ${bundle.manifest.bundle_id}`);
    const m = bundle.manifest;
    const prefix = (object: string) => `${m.source.platform}:${object}:`;
    const result: ImportResult = { id_map: {}, created: {}, matched: {}, skipped: {}, custom_fields_created: [], notes_created: 0 };
    const bump = (k: keyof Pick<ImportResult, "created" | "matched" | "skipped">, o: string, n = 1) => { result[k][o] = (result[k][o] ?? 0) + n; };

    // 1. Metadata: external-id field everywhere we write, custom fields/objects when approved.
    let meta = await client.objects();
    const metaByPlural = () => new Map(meta.map((o) => [o.namePlural, o]));
    const ensureField = async (plural: string, name: string, label: string, type: string, options?: TwentyFieldMeta["options"]) => {
      const o = metaByPlural().get(plural);
      if (!o) throw new Error(`target object ${plural} does not exist`);
      if (o.fields.some((f) => f.name === name)) return;
      log(`  creating field ${plural}.${name} (${type})`);
      const f = await client.createField({ objectMetadataId: o.id, name, label, type, options });
      o.fields.push(f);
      result.custom_fields_created.push(`${plural}.${name}`);
    };
    const ensureJunctionObject = async (p: Planned) => {
      if (!p.junction || !p.target) return;
      if (metaByPlural().has(p.target.plural)) return;
      const fromMeta = metaByPlural().get(p.junction.rel.from)!, toMeta = metaByPlural().get(p.junction.rel.to)!;
      log(`  creating object ${p.target.plural}`);
      const o = await client.createObject({ nameSingular: p.target.singular, namePlural: p.target.plural, labelSingular: labelOf(p.target.singular), labelPlural: labelOf(p.target.plural), icon: "IconLink", description: `UDMP junction ${p.obj.name}` });
      o.fields ??= [];
      meta.push(o);
      result.custom_fields_created.push(p.target.plural);
      for (const [name, tgt] of [[p.junction.rel.fromField, fromMeta], [p.junction.rel.toField, toMeta]] as const) {
        const rel = await client.createRelationField({ objectMetadataId: o.id, name: name.replace(/Id$/, ""), label: labelOf(name.replace(/Id$/, "")), targetObjectMetadataId: tgt.id, targetFieldLabel: labelOf(p.target.plural) });
        o.fields.push(rel, { id: rel.id + ":id", name, label: name, type: "UUID" });
        result.custom_fields_created.push(`${p.target.plural}.${name}`);
      }
    };

    const planned = buildPlan(m, meta, plan.options.create_custom_fields, plan).planned;
    for (const p of planned) {
      if (p.mapping.mode !== "create" || !p.target) continue;
      if (p.junction && !plan.options.create_custom_fields) continue;
      await ensureJunctionObject(p);
      await ensureField(p.target.plural, plan.options.external_id_field, "UDMP source id", "TEXT");
      if (plan.options.create_custom_fields)
        for (const f of p.mapping.fields) if (!f.target && f.disposition === "custom_field") {
          const def = p.obj.fields.find((x) => x.name === f.source)!;
          const t = twentyType(def);
          await ensureField(p.target.plural, camelField(f.source), def.display_name ?? labelOf(f.source), t.type, t.options);
        }
    }
    await ensureField("notes", plan.options.external_id_field, "UDMP source id", "TEXT");
    // Re-plan against the now-complete metadata so custom fields resolve as name matches.
    const final = buildPlan(m, meta, plan.options.create_custom_fields, plan).planned;

    // 2. Records, in topological order.
    const existingNotes = new Map<string, string>();
    for await (const n of client.list("notes", `${EXTERNAL_ID}[startsWith]:"${m.source.platform}:"`)) if (n[EXTERNAL_ID]) existingNotes.set(String(n[EXTERNAL_ID]), String(n.id));

    for (const name of plan.order) {
      if (ctx?.signal?.aborted) throw new Error("aborted");
      const p = final.find((x) => x.obj.name === name);
      if (!p) continue;
      const idMap: Record<string, string> = (result.id_map[name] ??= {});
      const { obj, mapping, target } = p;
      if (mapping.mode === "skip" || !target) { log(`skipping ${name} (${mapping.reason ?? "unmapped"})`); continue; }

      if (mapping.mode === "lookup") {
        const keyField = obj.fields.find((f) => mapping.fields.find((mf) => mf.source === f.name && mf.target === "userEmail"));
        const members = new Map<string, string>();
        for await (const w of client.list(target.plural)) if (w.userEmail) members.set(String(w.userEmail).toLowerCase(), String(w.id));
        let hit = 0, miss = 0;
        for await (const rec of bundle.records(name)) {
          const email = keyField ? String(rec[keyField.name] ?? "").toLowerCase() : "";
          const id = members.get(email);
          if (id) { idMap[pkOf(obj, rec)] = id; hit++; } else miss++;
        }
        bump("matched", name, hit); bump("skipped", name, miss);
        log(`${name} → ${target.plural}: ${hit} matched, ${miss} not found (lookup only)`);
        continue;
      }

      if (p.junction && !plan.options.create_custom_fields) {
        // Junction without a custom object: record links as a JSON note on the "from" side and set pointOfContact.
        await applyJunctionAsNote(p, bundle, result, client, existingNotes, final, log);
        continue;
      }
      const tmeta = metaByPlural().get(target.plural)!;
      const fieldMeta = new Map(tmeta.fields.map((f) => [f.name, f]));

      // Existing rows for this source → idempotency.
      for await (const row of client.list(target.plural, `${EXTERNAL_ID}[startsWith]:"${prefix(name)}"`)) {
        const ext = String(row[EXTERNAL_ID] ?? "");
        if (ext.startsWith(prefix(name))) idMap[ext.slice(prefix(name).length)] = String(row.id);
      }
      const existingCount = Object.keys(idMap).length;

      const softDelete = obj.soft_delete_field;
      const batch: Array<{ pk: string; input: Record<string, unknown>; rec: UdmpRecord; overflow: Record<string, unknown>; notes: Array<{ key: string; title: string; markdown: string }>; deleted: boolean; firstContact?: string }> = [];
      const flush = async () => {
        if (!batch.length) return;
        const rows = await client.createMany(target.plural, target.singular, batch.map((b) => b.input));
        for (let i = 0; i < rows.length; i++) {
          const b = batch[i], id = String(rows[i].id);
          idMap[b.pk] = id;
          bump("created", name);
          if (b.deleted) await client.softDelete(target.plural, id);
          for (const n of b.notes) await writeNote(client, existingNotes, result, n.key, n.title, n.markdown, { [`${target.singular}Id`]: id });
          if (Object.keys(b.overflow).length) {
            const key = `${prefix(name)}${b.pk}:unmapped`;
            await writeNote(client, existingNotes, result, key, `UDMP: unmapped fields from ${m.source.platform} ${name} ${b.pk}`, "```json\n" + JSON.stringify(b.overflow, null, 2) + "\n```", { [`${target.singular}Id`]: id });
          }
        }
        batch.length = 0;
      };

      let seen = 0;
      for await (const raw of bundle.records(name)) {
        seen++;
        const pk = pkOf(obj, raw);
        if (idMap[pk]) { bump("matched", name); continue; }
        const { record: rec, dangling } = rewriteReferences(obj, raw, result.id_map);
        const input: Record<string, unknown> = { [EXTERNAL_ID]: `${prefix(name)}${pk}` };
        const overflow: Record<string, unknown> = {};
        const notes: Array<{ key: string; title: string; markdown: string }> = [];
        for (const d of dangling) overflow[`${d.field} (dangling ${d.object} ${d.source_id})`] = raw[d.field];
        for (const fm of mapping.fields) {
          const def = obj.fields.find((f) => f.name === fm.source)!;
          const v = rec[fm.source];
          if (primaryKeyFields(obj).includes(fm.source)) continue;
          if (v === null || v === undefined) continue;
          if (fm.target === null) {
            if (fm.disposition === "json_note") overflow[fm.source] = describeValue(def, raw[fm.source]);
            continue;
          }
          if (fm.target === "deletedAt:soft-delete") continue;
          if (fm.target.startsWith("note:")) { const rt = v as RichText; notes.push({ key: `${prefix(name)}${pk}:${fm.source}`, title: def.display_name ?? labelOf(fm.source), markdown: typeof rt === "object" && rt && "markdown" in rt ? rt.markdown : String(v) }); continue; }
          const spec = FIELDS[target.plural]?.[fm.semantic ?? ""];
          if (fm.target === "stage") {
            const up = String(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
            const opt = [up, STAGE_SYNONYMS[up]].find((c) => c && fieldMeta.get("stage")?.options?.some((o) => o.value === c));
            if (opt) input.stage = opt; else overflow[fm.source] = v;
            continue;
          }
          if (spec?.set && fm.matched_by === "semantic") { spec.set(v, input, def); continue; }
          const leaf = fm.target.split(".")[0];
          const tm = fieldMeta.get(leaf);
          if (fm.target.includes(".")) { setPath(input, fm.target, v); continue; }
          const cv = tm ? coerce(def, v, tm) : v;
          if (cv === undefined) overflow[fm.source] = v; else input[fm.target] = cv;
        }
        const deleted = Boolean(softDelete && raw[softDelete]);
        batch.push({ pk, input, rec, overflow, notes, deleted });
        if (batch.length >= client.pageSize) await flush();
      }
      await flush();
      log(`${name} → ${target.plural}: ${result.created[name] ?? 0} created, ${existingCount} already present, ${seen} in bundle`);

      if (p.junction) await setPointOfContact(p, bundle, result, client, final, log);
    }
    return result;
  },
};

function describeValue(def: Field, v: unknown): unknown {
  if (def.type === "attachment" && v && typeof v === "object") { const a = v as Attachment; return { filename: a.filename, media_type: a.media_type, blob: a.blob, source_url: a.source_url, status: a.status }; }
  if (def.type === "richtext" && v && typeof v === "object") return (v as RichText).markdown;
  return v;
}

async function writeNote(client: TwentyClient, existing: Map<string, string>, result: ImportResult, key: string, title: string, markdown: string, target: Record<string, string>): Promise<void> {
  if (existing.has(key)) return;
  const note = await client.createOne("notes", "note", { title, bodyV2: { markdown }, [EXTERNAL_ID]: key });
  existing.set(key, String(note.id));
  await client.createOne("noteTargets", "noteTarget", { noteId: note.id, ...target });
  result.notes_created++;
}

/** First junction row per deal (in bundle order) becomes the opportunity's point of contact when the bundle has no explicit primary contact. */
async function setPointOfContact(p: Planned, bundle: BundleReader, result: ImportResult, client: TwentyClient, all: Planned[], log: (m: string) => void): Promise<void> {
  const rel = p.junction!.rel;
  const from = all.find((x) => x.target?.plural === rel.from && !x.junction), to = all.find((x) => x.target?.plural === rel.to && !x.junction);
  if (!from || !to || rel.from !== "opportunities" || rel.to !== "people") return;
  if (from.mapping.fields.some((f) => f.target === "pointOfContactId")) return;
  const fromField = p.obj.fields.find((f) => f.type === "reference" && f.reference?.object === from.obj.name)!.name;
  const toField = p.obj.fields.find((f) => f.type === "reference" && f.reference?.object === to.obj.name)!.name;
  const done = new Set<string>();
  let n = 0;
  for await (const row of bundle.records(p.obj.name)) {
    const deal = String(row[fromField]), person = String(row[toField]);
    if (done.has(deal)) continue;
    done.add(deal);
    const oppId = result.id_map[from.obj.name]?.[deal], personId = result.id_map[to.obj.name]?.[person];
    if (!oppId || !personId) continue;
    if (!(result.created[from.obj.name] ?? 0)) continue; // nothing new this run; existing opportunities keep their point of contact
    await client.update("opportunities", "opportunity", oppId, { pointOfContactId: personId });
    n++;
  }
  if (n) log(`  set pointOfContact on ${n} opportunities from ${p.obj.name}`);
}

async function applyJunctionAsNote(p: Planned, bundle: BundleReader, result: ImportResult, client: TwentyClient, existing: Map<string, string>, all: Planned[], log: (m: string) => void): Promise<void> {
  const rel = p.junction!.rel;
  const from = all.find((x) => x.target?.plural === rel.from && !x.junction)!, to = all.find((x) => x.target?.plural === rel.to && !x.junction)!;
  const fromField = p.obj.fields.find((f) => f.type === "reference" && f.reference?.object === from.obj.name)!.name;
  const toField = p.obj.fields.find((f) => f.type === "reference" && f.reference?.object === to.obj.name)!.name;
  const byFrom = new Map<string, UdmpRecord[]>();
  for await (const row of bundle.records(p.obj.name)) { const k = String(row[fromField]); (byFrom.get(k) ?? byFrom.set(k, []).get(k)!).push(row); }
  const platform = bundle.manifest.source.platform;
  for (const [src, rows] of byFrom) {
    const id = result.id_map[from.obj.name]?.[src];
    if (!id) { result.skipped[p.obj.name] = (result.skipped[p.obj.name] ?? 0) + rows.length; continue; }
    const links = rows.map((r) => ({ ...r, [toField]: result.id_map[to.obj.name]?.[String(r[toField])] ?? `dangling:${r[toField]}` }));
    await writeNote(client, existing, result, `${platform}:${p.obj.name}:${src}`, `UDMP: ${p.obj.name} links`, "```json\n" + JSON.stringify(links, null, 2) + "\n```", { [`${from.target!.singular}Id`]: id });
    result.created[p.obj.name] = (result.created[p.obj.name] ?? 0) + rows.length;
  }
  await setPointOfContact(p, bundle, result, client, all, log);
}

/**
 * Build the mapping plan. Semantic tags first, names second (against live target metadata),
 * then dispositions for everything else. Pure: no writes.
 */
export function buildPlan(m: Manifest, meta: TwentyObjectMeta[], createCustomFields: boolean, approved?: MappingPlan): { plan: MappingPlan; planned: Planned[] } {
  const byPlural = new Map(meta.map((o) => [o.namePlural, o]));
  const order = topologicalOrder(m);
  const junctions = new Map<string, { from: string; to: string }>();
  for (const r of m.schema.relationships ?? []) if (r.through) junctions.set(r.through.object, { from: r.from.object, to: r.to.object });
  const planned: Planned[] = [];
  const objTarget = new Map<string, { plural: string; singular: string; mode: "create" | "lookup" }>();

  for (const obj of m.schema.objects) {
    const t = obj.semantic ? OBJECTS[obj.semantic] : undefined;
    if (t && byPlural.has(t.plural)) objTarget.set(obj.name, t);
    else if (byPlural.has(obj.name) || byPlural.has(obj.name + "s")) {
      const p = byPlural.has(obj.name) ? obj.name : obj.name + "s";
      objTarget.set(obj.name, { plural: p, singular: byPlural.get(p)!.nameSingular, mode: "create" });
    }
  }

  for (const obj of m.schema.objects) {
    const prior = approved?.objects.find((o) => o.source === obj.name);
    const j = junctions.get(obj.name);
    const fields: FieldMapping[] = [];
    let target = objTarget.get(obj.name);
    let junction: Planned["junction"];
    let matched_by: ObjectMapping["matched_by"] = target ? (obj.semantic && OBJECTS[obj.semantic] ? "semantic" : "name") : "none";
    let reason: string | undefined;
    if (!target && j) {
      const from = objTarget.get(j.from), to = objTarget.get(j.to);
      if (from && to) {
        const jt = junctionTarget(from, to);
        target = { plural: jt.plural, singular: jt.singular, mode: "create" };
        junction = { rel: { from: from.plural, to: to.plural, fromField: jt.fromField, toField: jt.toField } };
        matched_by = "semantic";
        reason = createCustomFields ? `many_to_many ${j.from}↔${j.to}: custom object ${jt.plural} with ${jt.fromField}/${jt.toField} relations; first link per ${j.from} also sets pointOfContact` : `many_to_many ${j.from}↔${j.to}: stored as a JSON note on each ${from.plural} record (create_custom_fields=false); first link per ${j.from} also sets pointOfContact`;
      }
    }
    const tmeta = target ? byPlural.get(target.plural) : undefined;
    const specs = target ? FIELDS[target.plural] ?? {} : {};
    const pks = primaryKeyFields(obj);

    for (const f of obj.fields) {
      const priorF = prior?.fields.find((x) => x.source === f.name);
      const base: FieldMapping = { source: f.name, type: f.type, semantic: f.semantic, target: null };
      if (!target) { fields.push({ ...base, disposition: "skip", reason: "object not mapped" }); continue; }
      if (pks.includes(f.name)) { fields.push({ ...base, target: target.mode === "lookup" ? null : EXTERNAL_ID, matched_by: "custom", transform: target.mode === "lookup" ? undefined : `${m.source.platform}:${obj.name}:<id>`, disposition: target.mode === "lookup" ? "skip" : undefined, reason: target.mode === "lookup" ? "lookup only" : "idempotency key" }); continue; }
      if (junction) {
        const refTo = f.type === "reference" ? f.reference?.object : undefined;
        if (refTo === j!.from) { fields.push({ ...base, target: junction.rel.fromField, matched_by: "semantic", transform: "id map" }); continue; }
        if (refTo === j!.to) { fields.push({ ...base, target: junction.rel.toField, matched_by: "semantic", transform: "id map" }); continue; }
      }
      if (f.semantic === "common.deleted_at" || (obj.soft_delete_field && obj.soft_delete_field === f.name)) { fields.push({ ...base, target: "deletedAt:soft-delete", matched_by: "semantic", transform: "record is soft-deleted in Twenty after create" }); continue; }
      if (f.semantic === "common.updated_at") { fields.push({ ...base, disposition: "skip", reason: "Twenty maintains updatedAt" }); continue; }
      const spec = f.semantic ? specs[f.semantic] : undefined;
      if (spec && (spec.target.includes(":") || tmeta?.fields.some((x) => x.name === spec.target.split(".")[0]) || !tmeta)) {
        if (f.type === "reference" && !spec.transform?.startsWith("id map")) { /* fallthrough to name/unmapped */ } else { fields.push({ ...base, target: spec.target, matched_by: "semantic", transform: spec.transform }); continue; }
      }
      if (target.mode === "lookup") { fields.push({ ...base, disposition: "skip", reason: "lookup only" }); continue; }
      const cand = camelField(f.name);
      const tm = tmeta?.fields.find((x) => x.name === cand && !READ_ONLY.has(x.name) && SIMPLE_TYPES.has(x.type));
      if (tm && f.type !== "reference" && f.type !== "attachment" && f.type !== "richtext") { fields.push({ ...base, target: tm.name, matched_by: "name", transform: tm.type === "SELECT" ? "value uppercased to match SELECT options" : undefined }); continue; }
      // Unmapped.
      if (f.type === "reference") { const refTarget = f.reference ? objTarget.get(f.reference.object) : undefined; fields.push({ ...base, disposition: "json_note", reason: refTarget ? `${target.plural} has no field for a ${refTarget.plural} reference` : `references unmapped object ${f.reference?.object}` }); continue; }
      if (f.type === "attachment") { fields.push({ ...base, disposition: "json_note", reason: "file upload not supported via REST; filename and source_url recorded" }); continue; }
      if (f.type === "richtext") { fields.push({ ...base, disposition: "json_note", reason: "markdown stored in the note" }); continue; }
      const disp = priorF?.disposition ?? (createCustomFields ? "custom_field" : "json_note");
      const tt = twentyType(f);
      fields.push({ ...base, disposition: disp === "custom_field" && !createCustomFields ? "json_note" : disp, reason: f.is_custom ? `custom field → ${target.plural}.${cand} (${tt.type})` : `no ${target.plural} field for ${f.semantic ?? f.name}; → ${target.plural}.${cand} (${tt.type}) if custom fields are enabled` });
    }

    const mapping: ObjectMapping = {
      source: obj.name, semantic: obj.semantic, target: target?.plural ?? null,
      mode: target ? (prior?.mode === "skip" ? "skip" : target.mode) : "skip", matched_by, fields,
      reason: reason ?? (!target ? (obj.semantic ? `no Twenty object for ${obj.semantic}` : "no semantic tag and no Twenty object named " + obj.name) : target.mode === "lookup" ? "workspace members are never created; matched by email" : undefined),
    };
    planned.push({ obj, mapping, target: target ? { plural: target.plural, singular: target.singular } : undefined, junction });
  }

  const plan: MappingPlan = {
    importer: "twenty", importer_version: VERSION, bundle_id: m.bundle_id, source_platform: m.source.platform,
    order, objects: planned.map((p) => p.mapping),
    options: { create_custom_fields: createCustomFields, external_id_field: EXTERNAL_ID },
  };
  return { plan, planned };
}

/** Same algorithm as BundleReader.topologicalOrder, but from a manifest alone (plan() has no bundle on disk). */
function topologicalOrder(m: Manifest): string[] {
  const objects = new Map(m.schema.objects.map((o) => [o.name, o]));
  const rels = m.schema.relationships ?? [];
  const deps = new Map<string, Set<string>>();
  for (const o of objects.keys()) deps.set(o, new Set());
  for (const o of objects.values())
    for (const f of o.fields) {
      const target = f.type === "reference" ? f.reference?.object : f.type === "array" ? f.items?.reference?.object : undefined;
      if (target && target !== o.name && deps.has(target)) deps.get(o.name)!.add(target);
    }
  for (const r of rels) if (r.type !== "many_to_many" && r.from.object !== r.to.object) deps.get(r.to.object)?.add(r.from.object);
  const out: string[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (n: string) => { const s = state.get(n) ?? 0; if (s) return; state.set(n, 1); for (const d of deps.get(n) ?? []) visit(d); state.set(n, 2); out.push(n); };
  const junctions = new Set(rels.filter((r) => r.through).map((r) => r.through!.object));
  for (const o of objects.keys()) if (!junctions.has(o)) visit(o);
  for (const o of junctions) visit(o);
  return out;
}

export default importer;
