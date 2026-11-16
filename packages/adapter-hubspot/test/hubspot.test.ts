import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport, validateBundle, BundleReader } from "@udmp/core";
import adapter from "../src/index.js";

/**
 * Recorded-fixture HubSpot portal with two objects, a custom property, an enum,
 * an owner reference, a file property, and one association label. No network.
 */
const props: Record<string, unknown[]> = {
  companies: [
    { name: "name", label: "Company name", type: "string", fieldType: "text", hubspotDefined: true },
    { name: "domain", label: "Domain", type: "string", fieldType: "text", hubspotDefined: true },
    { name: "industry", label: "Industry", type: "enumeration", fieldType: "select", hubspotDefined: true, options: [{ label: "Software", value: "SOFTWARE", displayOrder: 0 }] },
    { name: "hubspot_owner_id", label: "Owner", type: "enumeration", fieldType: "select", hubspotDefined: true, referencedObjectType: "OWNER" },
    { name: "annual_contract_value", label: "ACV", type: "number", fieldType: "number", hubspotDefined: false },
    { name: "msa_document", label: "MSA", type: "string", fieldType: "file", hubspotDefined: false },
    { name: "hs_lastmodifieddate", label: "Last modified", type: "datetime", fieldType: "date", hubspotDefined: true },
  ],
  contacts: [
    { name: "email", label: "Email", type: "string", fieldType: "text", hubspotDefined: true },
    { name: "interests", label: "Interests", type: "enumeration", fieldType: "checkbox", hubspotDefined: false, options: [{ label: "API", value: "api" }, { label: "Pricing", value: "pricing" }] },
    { name: "notes_last_contacted", label: "Notes", type: "string", fieldType: "html", hubspotDefined: true },
  ],
};
const companies = [
  { id: "501", createdAt: "2024-02-01T10:00:00.000Z", updatedAt: "2026-10-30T09:12:00.000Z", archived: false, properties: { name: "Acme", domain: "acme.example", industry: "SOFTWARE", hubspot_owner_id: "1001", annual_contract_value: "120000", msa_document: "8821", hs_lastmodifieddate: "1761815520000" } },
  { id: "502", createdAt: "2023-07-15T08:30:00.000Z", updatedAt: "2026-11-01T16:45:00.000Z", archived: false, properties: { name: "Globex", domain: null, industry: "OTHER", hubspot_owner_id: null, annual_contract_value: null, msa_document: null, hs_lastmodifieddate: null } },
];
const contacts = [
  { id: "9001", createdAt: "2024-02-02T00:00:00.000Z", updatedAt: "2024-02-02T00:00:00.000Z", archived: false, properties: { email: "jane@acme.example", interests: "api;pricing", notes_last_contacted: "<p>Hi <b>Jane</b></p>" } },
];

function fakeFetch(): typeof fetch {
  return mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const h = init?.headers as Record<string, string>;
    if (u.host === "api.hubapi.com") assert.equal(h.authorization, "Bearer pat-test");
    const p = u.pathname;
    if (p === "/account-info/v3/details") return Response.json({ portalId: 847291, uiDomain: "app.hubspot.com", dataHostingLocation: "na1" });
    if (p.startsWith("/crm/v3/properties/")) return Response.json({ results: props[p.split("/").pop()!] ?? [] });
    if (p === "/crm/v4/associations/companies/contacts/labels") return Response.json({ results: [{ typeId: 2, label: null, category: "HUBSPOT_DEFINED" }, { typeId: 99, label: "Champion", category: "USER_DEFINED" }] });
    if (p.startsWith("/crm/v4/associations/") && p.endsWith("/labels")) return Response.json({ results: [] });
    if (p === "/crm/v3/objects/companies/search") { assert.equal(init?.method, "POST"); return Response.json({ results: companies }); }
    if (p === "/crm/v3/objects/contacts/search") return Response.json({ results: contacts });
    if (p === "/crm/v3/objects/companies") return Response.json({ results: companies.map((c) => ({ id: c.id })) });
    if (p === "/crm/v4/associations/companies/contacts/batch/read") return Response.json({ results: [{ from: { id: "501" }, to: [{ toObjectId: 9001, associationTypes: [{ typeId: 2, label: null, category: "HUBSPOT_DEFINED" }, { typeId: 99, label: "Champion", category: "USER_DEFINED" }] }] }] });
    if (p === "/crm/v3/owners") return Response.json({ results: u.searchParams.get("archived") === "true" ? [] : [{ id: 1001, email: "sam@acme-crm.example", firstName: "Sam", lastName: "Rivera", userId: 55, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" }] });
    if (p === "/files/v3/files/8821") return Response.json({ id: "8821", name: "acme-msa", extension: "pdf", size: 10 });
    if (p === "/files/v3/files/8821/signed-url") return Response.json({ url: "https://cdn.hubspot.example/signed/8821?token=abc" });
    if (u.host === "cdn.hubspot.example") return new Response(Buffer.from("%PDF-fake"), { headers: { "content-type": "application/pdf" } });
    throw new Error(`unexpected request ${u}`);
  }) as unknown as typeof fetch;
}

test("hubspot adapter discovers a dynamic schema and exports a level-3 bundle", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  const dir = mkdtempSync(join(tmpdir(), "udmp-hs-"));
  try {
    const m = await runExport(adapter, { access_token: "pat-test", objects: "companies,contacts" }, { out: dir });
    assert.equal(m.source.instance_id, "portal_847291");
    const names = m.schema.objects.map((o) => o.name);
    assert.deepEqual(names, ["owner", "account", "contact", "account_contact"]);

    const account = m.schema.objects.find((o) => o.name === "account")!;
    const acv = account.fields.find((f) => f.source_name === "annual_contract_value")!;
    assert.equal(acv.name, "cf_annual_contract_value");
    assert.equal(acv.is_custom, true);
    assert.equal(acv.type, "decimal");
    assert.equal(account.fields.find((f) => f.source_name === "hubspot_owner_id")!.type, "reference");
    assert.equal(account.fields.find((f) => f.source_name === "industry")!.enum!.values[0].label, "Software");
    assert.equal(account.semantic, "crm.account");

    const contact = m.schema.objects.find((o) => o.name === "contact")!;
    assert.equal(contact.fields.find((f) => f.source_name === "interests")!.type, "array");
    assert.equal(contact.fields.find((f) => f.source_name === "notes_last_contacted")!.type, "richtext");

    const rel = m.schema.relationships!.find((r) => r.name === "account_contact")!;
    assert.equal(rel.type, "many_to_many");
    assert.equal(rel.through!.object, "account_contact");
    assert.ok(m.schema.relationships!.some((r) => r.name === "account_owner"));

    const r = new BundleReader(dir);
    const accounts = []; for await (const x of r.records("account")) accounts.push(x);
    assert.equal(accounts[0].cf_annual_contract_value, "120000");
    assert.equal(accounts[0].hs_lastmodifieddate, "2025-10-30T09:12:00.000Z");
    assert.equal((accounts[0].cf_msa_document as { status: string; filename: string }).status, "ok");
    assert.equal((accounts[0].cf_msa_document as { filename: string }).filename, "acme-msa.pdf");
    assert.equal((accounts[0].cf_msa_document as { source_url: string }).source_url, "https://cdn.hubspot.example/signed/8821"); // token stripped
    assert.equal(accounts[1].industry, "OTHER"); // open enum carries unknown values
    const cs = []; for await (const x of r.records("contact")) cs.push(x);
    assert.deepEqual(cs[0].cf_interests, ["api", "pricing"]);
    assert.equal((cs[0].notes_last_contacted as { markdown: string }).markdown, "Hi **Jane**");
    const links = []; for await (const x of r.records("account_contact")) links.push(x);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map((l) => l.label), ["2", "99"]);

    const report = await validateBundle(dir);
    assert.equal(report.ok, true, JSON.stringify(report.issues, null, 1));
    assert.equal(report.effective_level, 3);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true });
  }
});
