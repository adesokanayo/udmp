/**
 * Builds examples/hubspot-sample deterministically. Run: pnpm tsx examples/build-sample.ts
 * The sample models a small HubSpot-like CRM with accounts, contacts, deals, a junction
 * object, custom fields, rich text and a bundled attachment.
 */
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BundleWriter, richTextFromHtml, type Schema } from "@udmp/core";

const dir = join(dirname(fileURLToPath(import.meta.url)), "hubspot-sample");
rmSync(dir, { recursive: true, force: true });

const schema: Schema = {
  objects: [
    {
      name: "owner", display_name: "Owners", semantic: "identity.user", source_name: "owners", primary_key: "id",
      fields: [
        { name: "id", type: "string", nullable: false, semantic: "common.id" },
        { name: "email", type: "string", semantic: "identity.user.email" },
        { name: "first_name", type: "string" }, { name: "last_name", type: "string" },
      ],
    },
    {
      name: "account", display_name: "Companies", semantic: "crm.account", source_name: "companies", primary_key: "id",
      fields: [
        { name: "id", type: "string", nullable: false, semantic: "common.id" },
        { name: "name", type: "string", nullable: false, semantic: "common.name", source_name: "name" },
        { name: "domain", type: "string", semantic: "crm.account.domain" },
        { name: "industry", type: "enum", semantic: "crm.account.industry", enum: { values: [{ value: "SOFTWARE", label: "Software" }, { value: "FINTECH", label: "Fintech" }], open: true } },
        { name: "numberofemployees", type: "integer", semantic: "crm.account.employee_count" },
        { name: "hubspot_owner_id", type: "reference", reference: { object: "owner" }, semantic: "common.owner" },
        { name: "cf_annual_contract_value", type: "decimal", is_custom: true, source_name: "annual_contract_value", display_name: "Annual Contract Value" },
        { name: "cf_hq_location", type: "geo", is_custom: true },
        { name: "created_at", type: "datetime", semantic: "common.created_at" },
        { name: "updated_at", type: "datetime", semantic: "common.updated_at" },
        { name: "deleted_at", type: "datetime", semantic: "common.deleted_at" },
      ],
      soft_delete_field: "deleted_at",
    },
    {
      name: "contact", display_name: "Contacts", semantic: "crm.contact", source_name: "contacts", primary_key: "id",
      fields: [
        { name: "id", type: "string", nullable: false },
        { name: "email", type: "string", semantic: "crm.contact.email", unique: true },
        { name: "firstname", type: "string", semantic: "crm.contact.first_name" },
        { name: "lastname", type: "string", semantic: "crm.contact.last_name" },
        { name: "account_id", type: "reference", reference: { object: "account" }, semantic: "crm.contact.account", source_name: "associatedcompanyid" },
        { name: "lifecyclestage", type: "enum", semantic: "crm.contact.lifecycle_stage", enum: { values: ["subscriber", "lead", "customer"].map((v) => ({ value: v })) } },
        { name: "cf_tshirt_size", type: "enum", is_custom: true, enum: { values: ["S", "M", "L"].map((v) => ({ value: v })) } },
        { name: "cf_interests", type: "array", is_custom: true, items: { type: "string" } },
        { name: "created_at", type: "datetime" },
      ],
    },
    {
      name: "deal", display_name: "Deals", semantic: "crm.deal", source_name: "deals", primary_key: "id",
      fields: [
        { name: "id", type: "string", nullable: false },
        { name: "dealname", type: "string", semantic: "common.name" },
        { name: "amount", type: "currency", semantic: "crm.deal.amount" },
        { name: "dealstage", type: "enum", semantic: "crm.deal.stage", enum: { values: [{ value: "qualified" }, { value: "proposal" }, { value: "closedwon" }, { value: "closedlost" }] } },
        { name: "closedate", type: "date", semantic: "crm.deal.close_date" },
        { name: "account_id", type: "reference", reference: { object: "account" }, semantic: "crm.deal.account" },
        { name: "hubspot_owner_id", type: "reference", reference: { object: "owner" }, semantic: "common.owner" },
        { name: "notes", type: "richtext", semantic: "common.description" },
        { name: "contract", type: "attachment" },
        { name: "created_at", type: "datetime" },
      ],
    },
    {
      name: "deal_contact", display_name: "Deal ↔ Contact", source_name: "associations/deals/contacts", primary_key: "id", is_junction: true,
      fields: [
        { name: "id", type: "string", nullable: false },
        { name: "deal_id", type: "reference", reference: { object: "deal" }, nullable: false },
        { name: "contact_id", type: "reference", reference: { object: "contact" }, nullable: false },
        { name: "label", type: "enum", enum: { values: [{ value: "3", label: "Deal to Contact" }, { value: "7", label: "Decision maker" }] } },
      ],
    },
  ],
  relationships: [
    { name: "account_contacts", type: "one_to_many", from: { object: "account", field: "id" }, to: { object: "contact", field: "account_id" } },
    { name: "account_deals", type: "one_to_many", from: { object: "account", field: "id" }, to: { object: "deal", field: "account_id" } },
    { name: "owner_accounts", type: "one_to_many", from: { object: "owner", field: "id" }, to: { object: "account", field: "hubspot_owner_id" } },
    { name: "owner_deals", type: "one_to_many", from: { object: "owner", field: "id" }, to: { object: "deal", field: "hubspot_owner_id" } },
    { name: "deal_contacts", type: "many_to_many", from: { object: "deal", field: "id" }, to: { object: "contact", field: "id" }, through: { object: "deal_contact", from_field: "deal_id", to_field: "contact_id" } },
  ],
};

const w = new BundleWriter({
  dir, schema, conformanceLevel: 3, bundleId: "7f8a3c2e-1b4d-4e6f-9a0b-2c3d4e5f6a7b", exportedAt: "2026-11-15T04:00:00Z",
  source: { platform: "hubspot", platform_display_name: "HubSpot", instance_id: "portal_847291", instance_url: "https://app.hubspot.com/contacts/847291", adapter: { name: "@udmp/adapter-hubspot", version: "1.0.0-rc.1" }, api_versions: { crm_objects: "v3", associations: "v4" } },
  export: { mode: "full", until: "2026-11-15T04:00:00Z" },
  maxRowsPerChunk: 3, // tiny chunks so the sample shows multi-file objects
});

await w.write("owner", { id: "1001", email: "sam@acme-crm.example", first_name: "Sam", last_name: "Rivera" });
await w.write("owner", { id: "1002", email: "lee@acme-crm.example", first_name: "Lee", last_name: "Okafor" });

const accounts = [
  { id: "501", name: "Acme Corp", domain: "acme.example", industry: "SOFTWARE", numberofemployees: 250, hubspot_owner_id: "1001", cf_annual_contract_value: "120000.00", cf_hq_location: { lat: 37.7749, lon: -122.4194 }, created_at: "2024-02-01T10:00:00Z", updated_at: "2026-10-30T09:12:00Z", deleted_at: null },
  { id: "502", name: "Globex", domain: "globex.example", industry: "FINTECH", numberofemployees: 1200, hubspot_owner_id: "1002", cf_annual_contract_value: "480000.00", cf_hq_location: null, created_at: "2023-07-15T08:30:00Z", updated_at: "2026-11-01T16:45:00Z", deleted_at: null },
  { id: "503", name: "Initech", domain: "initech.example", industry: "SOFTWARE", numberofemployees: 40, hubspot_owner_id: "1001", cf_annual_contract_value: "15000.00", cf_hq_location: null, created_at: "2025-01-20T12:00:00Z", updated_at: "2025-01-20T12:00:00Z", deleted_at: null },
  { id: "504", name: "Vandelay Industries", domain: "vandelay.example", industry: "IMPORT_EXPORT", numberofemployees: 12, hubspot_owner_id: null, cf_annual_contract_value: null, cf_hq_location: null, created_at: "2022-03-03T03:03:03Z", updated_at: "2026-06-01T00:00:00Z", deleted_at: "2026-06-01T00:00:00Z" },
];
for (const a of accounts) await w.write("account", a);

const contacts = [
  { id: "9001", email: "jane@acme.example", firstname: "Jane", lastname: "Doe", account_id: "501", lifecyclestage: "customer", cf_tshirt_size: "M", cf_interests: ["api", "pricing"], created_at: "2024-02-02T00:00:00Z" },
  { id: "9002", email: "raj@acme.example", firstname: "Raj", lastname: "Patel", account_id: "501", lifecyclestage: "lead", cf_tshirt_size: null, cf_interests: [], created_at: "2024-05-10T00:00:00Z" },
  { id: "9003", email: "mia@globex.example", firstname: "Mia", lastname: "Chen", account_id: "502", lifecyclestage: "customer", cf_tshirt_size: "S", cf_interests: ["security"], created_at: "2023-08-01T00:00:00Z" },
  { id: "9004", email: "ola@initech.example", firstname: "Ola", lastname: "Bakare", account_id: "503", lifecyclestage: "subscriber", cf_tshirt_size: "L", cf_interests: ["newsletter"], created_at: "2025-02-01T00:00:00Z" },
  { id: "9005", email: "orphan@nowhere.example", firstname: "No", lastname: "Company", account_id: null, lifecyclestage: "lead", cf_tshirt_size: null, cf_interests: null, created_at: "2026-01-01T00:00:00Z" },
];
for (const c of contacts) await w.write("contact", c);

const contractPdf = Buffer.from("%PDF-1.4\n% UDMP sample contract\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const contract = await w.addBlob(contractPdf, { filename: "acme-msa-2026.pdf", media_type: "application/pdf", source_url: "https://api.hubapi.com/files/v3/files/8821/signed-url?token=expired" });
const skipped = w.skippedBlob({ filename: "globex-deck.pptx", media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", source_url: "https://api.hubapi.com/files/v3/files/8822", bytes: 350_000_000 }, "exceeds cap of 104857600 bytes");

const deals = [
  { id: "7001", dealname: "Acme renewal 2027", amount: { amount: "120000.00", code: "USD" }, dealstage: "proposal", closedate: "2027-01-31", account_id: "501", hubspot_owner_id: "1001", notes: richTextFromHtml("<p>Call with <b>Jane</b> on Monday.</p><ul><li>Follow up on pricing</li><li>Send <a href=\"blob:" + contract.blob + "\">contract</a></li></ul>"), contract, created_at: "2026-10-01T00:00:00Z" },
  { id: "7002", dealname: "Globex expansion", amount: { amount: "480000.00", code: "USD" }, dealstage: "closedwon", closedate: "2026-09-15", account_id: "502", hubspot_owner_id: "1002", notes: richTextFromHtml("<p>Signed. <i>Security review</i> passed.</p>"), contract: skipped, created_at: "2026-06-01T00:00:00Z" },
  { id: "7003", dealname: "Initech pilot", amount: { amount: "15000.00", code: "USD" }, dealstage: "qualified", closedate: null, account_id: "503", hubspot_owner_id: "1001", notes: null, contract: null, created_at: "2026-11-01T00:00:00Z" },
];
for (const d of deals) await w.write("deal", d);

const links = [
  { id: "7001:9001:3", deal_id: "7001", contact_id: "9001", label: "3" },
  { id: "7001:9001:7", deal_id: "7001", contact_id: "9001", label: "7" },
  { id: "7001:9002:3", deal_id: "7001", contact_id: "9002", label: "3" },
  { id: "7002:9003:7", deal_id: "7002", contact_id: "9003", label: "7" },
  { id: "7003:9004:3", deal_id: "7003", contact_id: "9004", label: "3" },
];
for (const l of links) await w.write("deal_contact", l);

const m = await w.finalize({ stats: { duration_seconds: 42.5 } });
console.log(`wrote ${dir}: ${Object.values(m.stats!.records!).reduce((a, b) => a + b, 0)} records, ${m.blobs!.length} blobs`);
