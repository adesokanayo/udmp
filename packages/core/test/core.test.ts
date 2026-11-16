import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BundleWriter, BundleReader, writeBundle, validateBundle, validateManifestShape, validateManifestSemantics,
  importToSqlite, checkValue, computeScore, htmlToMarkdown, adfToMarkdown, readNdjson, type Schema, type Manifest,
} from "../src/index.js";
import { DatabaseSync } from "node:sqlite";

const tmp = () => mkdtempSync(join(tmpdir(), "udmp-"));

const schema: Schema = {
  objects: [
    { name: "account", primary_key: "id", semantic: "crm.account", fields: [
      { name: "id", type: "string", nullable: false }, { name: "name", type: "string" }, { name: "cf_acv", type: "decimal", is_custom: true },
    ] },
    { name: "contact", primary_key: "id", fields: [
      { name: "id", type: "string", nullable: false }, { name: "email", type: "string" },
      { name: "account_id", type: "reference", reference: { object: "account" } },
      { name: "tags", type: "array", items: { type: "string" } },
      { name: "bio", type: "richtext" }, { name: "photo", type: "attachment" },
    ] },
    { name: "tag_link", primary_key: ["contact_id", "account_id"], is_junction: true, fields: [
      { name: "contact_id", type: "reference", reference: { object: "contact" }, nullable: false },
      { name: "account_id", type: "reference", reference: { object: "account" }, nullable: false },
    ] },
  ],
  relationships: [
    { name: "account_contacts", type: "one_to_many", from: { object: "account", field: "id" }, to: { object: "contact", field: "account_id" } },
    { name: "contact_accounts", type: "many_to_many", from: { object: "contact", field: "id" }, to: { object: "account", field: "id" }, through: { object: "tag_link", from_field: "contact_id", to_field: "account_id" } },
  ],
};
const source = { platform: "test" };

test("write → read round trip, chunking, checksums, level 3", async () => {
  const dir = tmp();
  const w = new BundleWriter({ dir, schema, source, maxRowsPerChunk: 2, conformanceLevel: 3, gzip: true });
  const photo = await w.addBlob(Buffer.from("fake-jpeg-bytes"), { filename: "me.jpg", media_type: "image/jpeg", source_url: "https://cdn.example/x?sig=1" });
  assert.equal(photo.status, "ok");
  assert.match(photo.blob!, /^sha256-[a-f0-9]{64}$/);
  assert.equal(photo.source_url, "https://cdn.example/x"); // query stripped
  const dup = await w.addBlob(Buffer.from("fake-jpeg-bytes"), { filename: "me-again.jpg" });
  assert.equal(dup.blob, photo.blob);

  for (let i = 1; i <= 5; i++) await w.write("account", { id: `a${i}`, name: `Account ${i}`, cf_acv: `${i}000.00` });
  for (let i = 1; i <= 3; i++) await w.write("contact", { id: `c${i}`, email: `c${i}@x.example`, account_id: `a${i}`, tags: ["x"], bio: { markdown: "hi", original: { format: "plain", content: "hi" } }, photo: i === 1 ? photo : null });
  await w.write("tag_link", { contact_id: "c1", account_id: "a2" });
  const m = await w.finalize();

  assert.equal(m.data_files.find((g) => g.object === "account")!.files.length, 3);
  assert.equal(m.blobs!.length, 1);
  assert.equal(m.stats!.blobs_ok, 2);
  assert.ok(existsSync(join(dir, "udmp-manifest.yaml")));

  const r = new BundleReader(dir);
  assert.deepEqual(r.issues, []);
  const ids: string[] = [];
  for await (const rec of r.records("account")) ids.push(String(rec.id));
  assert.deepEqual(ids, ["a1", "a2", "a3", "a4", "a5"]);
  assert.deepEqual(r.topologicalOrder(), ["account", "contact", "tag_link"]);
  assert.ok(r.blobPath(photo.blob!)!.endsWith(".jpg"));

  const report = await validateBundle(dir);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.effective_level, 3);
  assert.equal(report.dangling, 0);
  rmSync(dir, { recursive: true });
});

test("validator catches dangling references, bad types, row_count and checksum tampering", async () => {
  const dir = tmp();
  await writeBundle({ dir, schema, source, conformanceLevel: 2 }, {
    account: [{ id: "a1", name: "A", cf_acv: "1.00" }],
    contact: [{ id: "c1", email: "e", account_id: "a1", tags: ["ok"], bio: null, photo: null }, { id: "c2", email: "e", account_id: "ghost", tags: "not-an-array", bio: null, photo: null }],
    tag_link: [],
  });
  const report = await validateBundle(dir);
  assert.equal(report.ok, false);
  assert.equal(report.dangling, 1);
  assert.ok(report.issues.some((i) => i.code === "dangling_ref"));
  assert.ok(report.issues.some((i) => i.code === "type" && /tags/.test(i.message)));
  assert.equal(report.effective_level, 0); // type error → not even level 1

  // Tamper with a data file: row_count and sha256 must both trip.
  const mPath = join(dir, "udmp-manifest.json");
  const m = JSON.parse(readFileSync(mPath, "utf8")) as Manifest;
  const f = m.data_files.find((g) => g.object === "account")!.files[0];
  writeFileSync(join(dir, f.path), JSON.stringify({ id: "a1", name: "A", cf_acv: "1.00" }) + "\n" + JSON.stringify({ id: "a9", name: "Z", cf_acv: "9.00" }) + "\n");
  const r2 = await validateBundle(dir);
  assert.ok(r2.issues.some((i) => i.code === "sha_mismatch"));
  assert.ok(r2.issues.some((i) => i.code === "row_count"));
  rmSync(dir, { recursive: true });
});

test("manifest shape and semantic validation", () => {
  const minimal = {
    udmp_version: "1.0.0", bundle_id: "7f8a3c2e-1b4d-4e6f-9a0b-2c3d4e5f6a7b", exported_at: "2026-11-15T04:00:00Z",
    source: { platform: "example" }, export: { mode: "full" }, conformance: { level: 1 },
    schema: { objects: [{ name: "thing", primary_key: "id", fields: [{ name: "id", type: "string", nullable: false }] }], relationships: [] },
    data_files: [{ object: "thing", format: "ndjson", files: [{ path: "data/thing/00001.ndjson", row_count: 1 }] }],
  };
  assert.deepEqual(validateManifestShape(minimal), []);
  assert.deepEqual(validateManifestSemantics(minimal as unknown as Manifest), []);

  const bad = structuredClone(minimal) as Record<string, unknown>;
  (bad.schema as { objects: Array<{ primary_key: string }> }).objects[0].primary_key = "nope";
  const issues = validateManifestSemantics(bad as unknown as Manifest);
  assert.ok(issues.some((i) => i.code === "pk_missing"));

  const traversal = structuredClone(minimal) as Record<string, unknown>;
  (traversal.data_files as Array<{ files: Array<{ path: string }> }>)[0].files[0].path = "../etc/passwd";
  assert.ok(validateManifestShape(traversal).length > 0, "path traversal must fail schema validation");

  const incremental = structuredClone(minimal) as Record<string, unknown>;
  (incremental.export as { mode: string }).mode = "incremental";
  assert.ok(validateManifestShape(incremental).length > 0, "incremental requires since + parent_bundle_id");
});

test("checkValue covers the type system", () => {
  assert.equal(checkValue({ type: "decimal" }, "12.50"), null);
  assert.notEqual(checkValue({ type: "decimal" }, 12.5), null);
  assert.equal(checkValue({ type: "datetime" }, "2026-11-15T04:00:00Z"), null);
  assert.notEqual(checkValue({ type: "datetime" }, "2026-11-15"), null);
  assert.equal(checkValue({ type: "currency" }, { amount: "1.00", code: "EUR" }), null);
  assert.equal(checkValue({ type: "enum", enum: { values: [{ value: "a" }], open: false } }, "b")?.includes("not in enum"), true);
  assert.equal(checkValue({ type: "enum", enum: { values: [{ value: "a" }] } }, "b"), null); // open by default
  assert.equal(checkValue({ type: "attachment" }, { status: "ok", blob: "sha256-" + "a".repeat(64) }), null);
  assert.notEqual(checkValue({ type: "attachment" }, { status: "ok", blob: null }), null);
  assert.equal(checkValue({ type: "attachment" }, { status: "skipped", blob: null, source_url: "x" }), null);
  assert.equal(checkValue({ type: "duration" }, "PT90M"), null);
  assert.equal(checkValue({ type: "geo" }, { lat: 1, lon: 2 }), null);
  assert.equal(checkValue({ type: "integer" }, "92233720368547758070"), null);
});

test("SQLite importer builds tables with PK/FK and loads rows in dependency order", async () => {
  const dir = tmp();
  await writeBundle({ dir, schema, source, conformanceLevel: 2 }, {
    account: [{ id: "a1", name: "A", cf_acv: "1.00" }, { id: "a2", name: "B", cf_acv: null }],
    contact: [{ id: "c1", email: "e", account_id: "a1", tags: ["x", "y"], bio: { markdown: "**hi**" }, photo: null }],
    tag_link: [{ contact_id: "c1", account_id: "a2" }],
  });
  const db = join(dir, "out.sqlite");
  const res = await importToSqlite(dir, db);
  assert.equal(res.tables, 3);
  assert.equal(res.rows, 4);
  const d = new DatabaseSync(db);
  const row = d.prepare(`SELECT c.email, a.name, c.tags, c.bio FROM contact c JOIN account a ON a.id = c.account_id`).get() as Record<string, unknown>;
  assert.equal(row.name, "A");
  assert.equal(row.tags, '["x","y"]');
  assert.equal(row.bio, "**hi**");
  const fks = d.prepare(`PRAGMA foreign_key_list(contact)`).all() as Array<{ table: string }>;
  assert.equal(fks[0].table, "account");
  const prov = d.prepare(`SELECT platform FROM _udmp_bundle`).get() as { platform: string };
  assert.equal(prov.platform, "test");
  d.close();
  rmSync(dir, { recursive: true });
});

test("richtext converters", () => {
  assert.equal(htmlToMarkdown("<p>Hi <b>there</b></p><ul><li>one</li><li>two</li></ul>"), "Hi **there**\n\n-   one\n-   two");
  const adf = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
    { type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "strong" }] }, { type: "text", text: " and " }, { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x" } }] }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "done" }] }] },
  ] };
  assert.equal(adfToMarkdown(adf), "## Title\n\n**bold** and [link](https://x)\n\n- a\n\n- [x] done");
});

test("exit score computation and validation", () => {
  const ok = computeScore({ platform: "x", display_name: "X", scored_at: "2026-11-15", scored_by: "@a", criteria: {
    api_access: { points: 20, evidence: ["https://x/docs"] }, schema_introspection: { points: 15, evidence: ["https://x"] },
    relational_integrity: { points: 15, evidence: ["https://x"] }, export_throughput: { points: 10, evidence: ["https://x"] },
    attachment_portability: { points: 15, evidence: ["https://x"] },
  } });
  assert.equal(ok.total, 75); assert.equal(ok.grade, "B"); assert.deepEqual(ok.errors, []);
  const bad = computeScore({ platform: "x", display_name: "X", scored_at: "yesterday", scored_by: "", criteria: { api_access: { points: 17, evidence: [] } } as never });
  assert.ok(bad.errors.length >= 4);
});

test("ndjson reader rejects non-object lines with location", async () => {
  const dir = tmp();
  const p = join(dir, "x.ndjson");
  writeFileSync(p, '{"a":1}\n[1,2]\n');
  const it = readNdjson(p);
  await it.next();
  await assert.rejects(() => it.next(), /x\.ndjson:2/);
  rmSync(dir, { recursive: true });
});
