import { mock } from "node:test";
import assert from "node:assert/strict";

/**
 * In-memory Twenty tenant: enough of the REST + metadata API for the importer.
 * Records live in `store[plural]`; metadata in `objects`. No network.
 */
type Row = Record<string, unknown>;
export interface FakeTwenty { fetch: typeof fetch; store: Record<string, Row[]>; objects: Meta[]; calls: string[] }
interface Meta { id: string; nameSingular: string; namePlural: string; isCustom: boolean; isActive: boolean; fields: Array<{ id: string; name: string; label: string; type: string; isCustom?: boolean; options?: Array<{ value: string; label: string }> }> }

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const std = (singular: string, plural: string, fields: Array<[string, string, Array<{ value: string; label: string }>?]>): Meta => ({
  id: uuid(), nameSingular: singular, namePlural: plural, isCustom: false, isActive: true,
  fields: [["id", "UUID"], ["createdAt", "DATE_TIME"], ["updatedAt", "DATE_TIME"], ["deletedAt", "DATE_TIME"], ...fields].map(([name, type, options]) => ({ id: uuid(), name, label: name, type, options })),
});

export function fakeTwenty(apiKey = "tw_test"): FakeTwenty {
  const objects: Meta[] = [
    std("company", "companies", [["name", "TEXT"], ["domainName", "LINKS"], ["employees", "NUMBER"], ["annualRecurringRevenue", "CURRENCY"], ["address", "ADDRESS"], ["accountOwnerId", "UUID"], ["accountOwner", "RELATION"], ["idealCustomerProfile", "BOOLEAN"]]),
    std("person", "people", [["name", "FULL_NAME"], ["emails", "EMAILS"], ["phones", "PHONES"], ["jobTitle", "TEXT"], ["city", "TEXT"], ["companyId", "UUID"], ["company", "RELATION"]]),
    std("opportunity", "opportunities", [["name", "TEXT"], ["amount", "CURRENCY"], ["closeDate", "DATE_TIME"], ["stage", "SELECT", [{ value: "NEW", label: "New" }, { value: "SCREENING", label: "Screening" }, { value: "MEETING", label: "Meeting" }, { value: "PROPOSAL", label: "Proposal" }, { value: "CUSTOMER", label: "Customer" }]], ["companyId", "UUID"], ["pointOfContactId", "UUID"]]),
    std("workspaceMember", "workspaceMembers", [["name", "FULL_NAME"], ["userEmail", "TEXT"]]),
    std("note", "notes", [["title", "TEXT"], ["bodyV2", "RICH_TEXT_V2"]]),
    std("noteTarget", "noteTargets", [["noteId", "UUID"], ["companyId", "UUID"], ["personId", "UUID"], ["opportunityId", "UUID"]]),
  ];
  const store: Record<string, Row[]> = Object.fromEntries(objects.map((o) => [o.namePlural, []]));
  store.workspaceMembers.push(
    { id: uuid(), name: { firstName: "Sam", lastName: "Rivera" }, userEmail: "sam@acme-crm.example" },
    { id: uuid(), name: { firstName: "Someone", lastName: "Else" }, userEmail: "else@acme-crm.example" },
  );
  const calls: string[] = [];
  const json = (data: unknown, extra: Record<string, unknown> = {}, status = 200) => Response.json({ data, ...extra }, { status });
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

  const matches = (row: Row, filter: string | null): boolean => {
    if (!filter) return true;
    const m = /^(\w+)\[(\w+)\]:"?([^"]*)"?$/.exec(filter);
    assert.ok(m, `unsupported filter ${filter}`);
    const [, field, op, val] = m;
    const v = row[field];
    if (op === "eq") return String(v) === val;
    if (op === "startsWith") return typeof v === "string" && v.startsWith(val);
    throw new Error(`unsupported op ${op}`);
  };
  const create = (plural: string, input: Row): Row => {
    const meta = objects.find((o) => o.namePlural === plural);
    assert.ok(meta, `no object ${plural}`);
    for (const k of Object.keys(input)) assert.ok(meta.fields.some((f) => f.name === k), `${plural}: unknown field "${k}" (fields: ${meta.fields.map((f) => f.name).join(",")})`);
    if (typeof input.stage === "string") assert.ok(meta.fields.find((f) => f.name === "stage")!.options!.some((o) => o.value === input.stage), `bad stage ${input.stage}`);
    const row = { id: uuid(), createdAt: new Date().toISOString(), deletedAt: null, ...input };
    store[plural].push(row);
    return row;
  };

  const fetchImpl = mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${apiKey}`);
    assert.equal(url.origin, "https://twenty.test");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const parts = url.pathname.replace(/^\/rest\//, "").split("/");

    if (parts[0] === "metadata") {
      if (method === "GET" && parts[1] === "objects") return json({ objects });
      if (method === "POST" && parts[1] === "objects") {
        const o: Meta = { id: uuid(), nameSingular: body.nameSingular, namePlural: body.namePlural, isCustom: true, isActive: true, fields: [["id", "UUID"], ["createdAt", "DATE_TIME"], ["updatedAt", "DATE_TIME"], ["deletedAt", "DATE_TIME"], ["name", "TEXT"]].map(([name, type]) => ({ id: uuid(), name, label: name, type })) };
        objects.push(o); store[o.namePlural] = [];
        return json({ createOneObject: o });
      }
      if (method === "POST" && parts[1] === "fields") {
        const o = objects.find((x) => x.id === body.objectMetadataId);
        assert.ok(o, "bad objectMetadataId");
        assert.match(body.name, /^[a-z][a-zA-Z0-9]*$/);
        assert.ok(!o.fields.some((f) => f.name === body.name), `duplicate field ${o.namePlural}.${body.name}`);
        const f = { id: uuid(), name: body.name, label: body.label, type: body.type, isCustom: true, options: body.options };
        o.fields.push(f);
        if (body.type === "RELATION") o.fields.push({ id: uuid(), name: body.name + "Id", label: body.name + "Id", type: "UUID", isCustom: true });
        return json({ createOneField: f });
      }
      return json({}, {}, 404);
    }

    if (parts[0] === "batch" && method === "POST") {
      const plural = parts[1];
      assert.ok(Array.isArray(body) && body.length <= 60);
      return json({ [`create${cap(plural)}`]: body.map((r: Row) => create(plural, r)) });
    }
    const plural = parts[0];
    const meta = objects.find((o) => o.namePlural === plural);
    if (!meta) return json({}, { error: `no ${plural}` }, 404);
    if (method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 60);
      const after = Number(url.searchParams.get("starting_after") ?? 0);
      const all = store[plural].filter((r) => matches(r, url.searchParams.get("filter")));
      const page = all.slice(after, after + limit);
      return json({ [plural]: page }, { pageInfo: { hasNextPage: after + page.length < all.length, endCursor: String(after + page.length) }, totalCount: all.length });
    }
    if (method === "POST") return json({ [`create${cap(meta.nameSingular)}`]: create(plural, body) });
    if (method === "PATCH") { const row = store[plural].find((r) => r.id === parts[1]); assert.ok(row); Object.assign(row, body); return json({ [`update${cap(meta.nameSingular)}`]: row }); }
    if (method === "DELETE") { const row = store[plural].find((r) => r.id === parts[1]); assert.ok(row); row.deletedAt = new Date().toISOString(); return json({ [`delete${cap(meta.nameSingular)}`]: { id: row.id } }); }
    return json({}, {}, 405);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, store, objects, calls };
}
