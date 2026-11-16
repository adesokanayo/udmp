import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BundleReader, formatPlan } from "@udmp/core";
import importer from "../src/index.js";
import { fakeTwenty } from "./fake-twenty.js";

const here = dirname(fileURLToPath(import.meta.url));
const sample = resolve(here, "../../../examples/hubspot-sample");
const config = { api_key: "tw_test", base_url: "https://twenty.test", page_size: "2" };
const ctx = { log: () => {} };

async function withTenant<T>(fn: (t: ReturnType<typeof fakeTwenty>) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const t = fakeTwenty();
  globalThis.fetch = t.fetch;
  try { return await fn(t); } finally { globalThis.fetch = real; }
}

test("plan: maps the HubSpot sample onto Twenty by semantic tag and lists every unmapped field", async () => {
  await withTenant(async () => {
    const bundle = new BundleReader(sample);
    const plan = await importer.plan(config, bundle.manifest, ctx);
    assert.equal(plan.bundle_id, bundle.manifest.bundle_id);
    assert.deepEqual(plan.order, bundle.topologicalOrder());
    const by = Object.fromEntries(plan.objects.map((o) => [o.source, o]));
    assert.equal(by.account.target, "companies");
    assert.equal(by.contact.target, "people");
    assert.equal(by.deal.target, "opportunities");
    assert.equal(by.owner.target, "workspaceMembers");
    assert.equal(by.owner.mode, "lookup");
    assert.equal(by.deal_contact.target, "opportunityPersonLinks");
    const f = (o: string, n: string) => by[o].fields.find((x) => x.source === n)!;
    assert.equal(f("account", "domain").target, "domainName.primaryLinkUrl");
    assert.equal(f("account", "hubspot_owner_id").target, "accountOwnerId");
    assert.equal(f("contact", "account_id").target, "companyId");
    assert.equal(f("deal", "amount").target, "amount");
    assert.equal(f("deal", "notes").target, "note:bodyV2.markdown");
    assert.equal(f("deal_contact", "deal_id").target, "opportunityId");
    assert.equal(f("deal_contact", "contact_id").target, "personId");
    // Unmapped fields are surfaced, never silently dropped (§11.2).
    assert.equal(f("account", "cf_annual_contract_value").target, null);
    assert.equal(f("account", "cf_annual_contract_value").disposition, "custom_field");
    assert.equal(f("account", "industry").disposition, "custom_field");
    assert.equal(f("contact", "cf_interests").disposition, "custom_field");
    assert.equal(f("deal", "contract").disposition, "json_note");
    assert.equal(f("deal", "hubspot_owner_id").disposition, "json_note");
    assert.equal(f("account", "updated_at").disposition, "skip");
    const text = formatPlan(plan);
    assert.match(text, /account → companies\s+\[create, by semantic\]/);
    assert.match(text, /cf_annual_contract_value\s+decimal\s+✗ unmapped → custom_field/);
    assert.match(text, /\d+ unmapped field\(s\)/);
  });
});

test("apply: imports the sample into a mocked tenant, links the junction, and is idempotent", async () => {
  await withTenant(async (t) => {
    const bundle = new BundleReader(sample);
    const plan = await importer.plan(config, bundle.manifest, ctx);
    const res = await importer.apply(config, bundle, plan, ctx);

    // id map covers every object, in the shape the spec requires
    assert.deepEqual(Object.keys(res.id_map).sort(), ["account", "contact", "deal", "deal_contact", "owner"]);
    assert.equal(Object.keys(res.id_map.account).length, 4);
    assert.equal(Object.keys(res.id_map.contact).length, 5);
    assert.equal(Object.keys(res.id_map.deal).length, 3);
    assert.equal(Object.keys(res.id_map.deal_contact).length, 5);
    assert.deepEqual(res.created, { account: 4, contact: 5, deal: 3, deal_contact: 5 });
    // owner 1001 exists in the workspace, 1002 does not → lookup only, never created
    assert.equal(Object.keys(res.id_map.owner).length, 1);
    assert.deepEqual(res.skipped, { owner: 1 });
    assert.equal(t.store.workspaceMembers.length, 2);

    // custom fields were created via the metadata API
    assert.ok(res.custom_fields_created.includes("companies.annualContractValue"));
    assert.ok(res.custom_fields_created.includes("companies.industry"));
    assert.ok(res.custom_fields_created.includes("people.tshirtSize"));
    assert.ok(res.custom_fields_created.includes("opportunityPersonLinks"));
    const companies = t.objects.find((o) => o.namePlural === "companies")!;
    assert.equal(companies.fields.find((f) => f.name === "industry")!.type, "SELECT");
    assert.equal(companies.fields.find((f) => f.name === "hqLocation")!.type, "RAW_JSON");

    // references rewritten through the id map
    const acme = t.store.companies.find((c) => c.udmpSourceId === "hubspot:account:501")!;
    assert.equal(acme.name, "Acme Corp");
    assert.deepEqual(acme.domainName, { primaryLinkUrl: "https://acme.example" });
    assert.equal(acme.employees, 250);
    assert.equal(acme.accountOwnerId, res.id_map.owner["1001"]);
    assert.equal(acme.annualContractValue, 120000);
    assert.equal(acme.industry, "SOFTWARE");
    assert.deepEqual(acme.hqLocation, { lat: 37.7749, lon: -122.4194 });
    const globex = t.store.companies.find((c) => c.udmpSourceId === "hubspot:account:502")!;
    assert.equal(globex.accountOwnerId, undefined, "owner 1002 is not in the workspace → dangling, goes to the note");
    const vandelay = t.store.companies.find((c) => c.udmpSourceId === "hubspot:account:504")!;
    assert.ok(vandelay.deletedAt, "soft-deleted in the bundle → soft-deleted in Twenty");

    const jane = t.store.people.find((p) => p.udmpSourceId === "hubspot:contact:9001")!;
    assert.deepEqual(jane.name, { firstName: "Jane", lastName: "Doe" });
    assert.deepEqual(jane.emails, { primaryEmail: "jane@acme.example" });
    assert.equal(jane.companyId, acme.id);
    assert.equal(jane.tshirtSize, "M");
    assert.deepEqual(jane.interests, ["api", "pricing"]);
    assert.equal(t.store.people.find((p) => p.udmpSourceId === "hubspot:contact:9005")!.companyId ?? null, null);

    const renewal = t.store.opportunities.find((o) => o.udmpSourceId === "hubspot:deal:7001")!;
    assert.deepEqual(renewal.amount, { amountMicros: 120_000_000_000, currencyCode: "USD" });
    assert.equal(renewal.stage, "PROPOSAL");
    assert.equal(renewal.companyId, acme.id);
    assert.equal(renewal.closeDate, "2027-01-31");
    assert.equal(t.store.opportunities.find((o) => o.udmpSourceId === "hubspot:deal:7002")!.stage, "CUSTOMER", "closedwon → CUSTOMER synonym");

    // junction → opportunity–person links, plus first link as point of contact
    const links = t.store.opportunityPersonLinks;
    assert.equal(links.length, 5);
    assert.ok(links.every((l) => t.store.opportunities.some((o) => o.id === l.opportunityId) && t.store.people.some((p) => p.id === l.personId)));
    assert.equal(links.filter((l) => l.opportunityId === renewal.id && l.personId === jane.id).length, 2);
    assert.equal(links[0].label, "V_3", "junction fields become custom fields; enum 3 becomes SELECT option V_3 since values must start with a letter");
    assert.equal(renewal.pointOfContactId, jane.id);

    // richtext → Note; unmapped attachment + owner → JSON note; both attached to the opportunity
    const notesFor = (id: string) => t.store.noteTargets.filter((nt) => nt.opportunityId === id).map((nt) => t.store.notes.find((n) => n.id === nt.noteId)!);
    const renewalNotes = notesFor(String(renewal.id));
    assert.equal(renewalNotes.length, 2);
    assert.match(String((renewalNotes[0].bodyV2 as { markdown: string }).markdown), /Call with \*\*Jane\*\* on Monday/);
    assert.match(String((renewalNotes[1].bodyV2 as { markdown: string }).markdown), /acme-msa-2026\.pdf/);
    assert.match(String((renewalNotes[1].bodyV2 as { markdown: string }).markdown), /hubspot_owner_id/);
    assert.ok(res.notes_created >= 6);

    // ---- second apply: nothing new ----
    const before = { companies: t.store.companies.length, people: t.store.people.length, opportunities: t.store.opportunities.length, links: t.store.opportunityPersonLinks.length, notes: t.store.notes.length, calls: t.calls.length };
    const plan2 = await importer.plan(config, bundle.manifest, ctx);
    assert.equal(plan2.objects.find((o) => o.source === "account")!.fields.find((f) => f.source === "cf_annual_contract_value")!.target, "annualContractValue", "second plan sees the custom field by name");
    const res2 = await importer.apply(config, bundle, plan2, ctx);
    assert.deepEqual(res2.created, {});
    assert.deepEqual(res2.custom_fields_created, []);
    assert.equal(res2.notes_created, 0);
    assert.deepEqual(res2.id_map, res.id_map);
    assert.deepEqual(res2.matched, { account: 4, contact: 5, deal: 3, deal_contact: 5, owner: 1 });
    assert.equal(t.store.companies.length, before.companies);
    assert.equal(t.store.people.length, before.people);
    assert.equal(t.store.opportunities.length, before.opportunities);
    assert.equal(t.store.opportunityPersonLinks.length, before.links);
    assert.equal(t.store.notes.length, before.notes);
    assert.ok(!t.calls.slice(before.calls).some((c) => /^(POST|PATCH|DELETE) /.test(c)), "second apply made no write calls");
  });
});

test("apply with create_custom_fields=false stores unmapped values and junction links in JSON notes", async () => {
  await withTenant(async (t) => {
    const bundle = new BundleReader(sample);
    const plan = await importer.plan(config, bundle.manifest, ctx);
    plan.options.create_custom_fields = false;
    const res = await importer.apply(config, bundle, plan, ctx);
    assert.deepEqual(res.custom_fields_created.filter((f) => !f.endsWith(".udmpSourceId")), []);
    assert.equal(t.store.opportunityPersonLinks, undefined);
    const acme = t.store.companies.find((c) => c.udmpSourceId === "hubspot:account:501")!;
    assert.equal(acme.industry, undefined);
    const note = t.store.noteTargets.filter((nt) => nt.companyId === acme.id).map((nt) => t.store.notes.find((n) => n.id === nt.noteId)!);
    assert.equal(note.length, 1);
    assert.match(String((note[0].bodyV2 as { markdown: string }).markdown), /"cf_annual_contract_value": "120000.00"/);
    const renewal = t.store.opportunities.find((o) => o.udmpSourceId === "hubspot:deal:7001")!;
    const jane = t.store.people.find((p) => p.udmpSourceId === "hubspot:contact:9001")!;
    assert.equal(renewal.pointOfContactId, jane.id);
    const linkNotes = t.store.notes.filter((n) => String(n.udmpSourceId).startsWith("hubspot:deal_contact:"));
    assert.equal(linkNotes.length, 3);
    assert.equal(res.created.deal_contact, 5);
  });
});

test("importer refuses to run without an api key", async () => {
  await assert.rejects(() => importer.connect({ api_key: "" }), /api_key is required/);
});
