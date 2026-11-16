import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runExport, type Adapter, type Schema } from "@udmp/core";
import { main } from "../src/main.js";

const here = dirname(fileURLToPath(import.meta.url));
const sample = resolve(here, "../../../examples/hubspot-sample");
const capture = () => { const out: string[] = [], err: string[] = []; return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err }; };

test("validate: the shipped sample is a conformant level-3 bundle", async () => {
  const c = capture();
  const code = await main(["validate", sample], c.io);
  assert.equal(code, 0, c.out.join("\n"));
  assert.match(c.out.join("\n"), /effective level 3/);
});

test("inspect: summarises the sample", async () => {
  const c = capture();
  assert.equal(await main(["inspect", sample], c.io), 0);
  const text = c.out.join("\n");
  assert.match(text, /HubSpot \(portal_847291\)/);
  assert.match(text, /deal_contacts\s+deal -\[many_to_many\]-> contact via deal_contact/);
  assert.match(text, /crm\.account/);
});

test("to-sqlite: loads the sample and joins across the junction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "udmp-cli-"));
  const db = join(dir, "crm.sqlite");
  const c = capture();
  assert.equal(await main(["to-sqlite", sample, db, "--quiet"], c.io), 0);
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(db);
  const rows = d.prepare(`
    SELECT d.dealname, c.email FROM deal d
    JOIN deal_contact dc ON dc.deal_id = d.id
    JOIN contact c ON c.id = dc.contact_id
    WHERE dc.label = '7' ORDER BY d.id`).all() as Array<{ dealname: string; email: string }>;
  assert.deepEqual(rows.map((r) => r.email), ["jane@acme.example", "mia@globex.example"]);
  const acv = d.prepare(`SELECT SUM(CAST(cf_annual_contract_value AS REAL)) AS s FROM account WHERE deleted_at IS NULL`).get() as { s: number };
  assert.equal(acv.s, 615000);
  d.close();
  rmSync(dir, { recursive: true });
});

test("export: generic runner drives a fake adapter end to end, then validate passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "udmp-exp-"));
  const schema: Schema = {
    objects: [
      { name: "user", primary_key: "id", semantic: "identity.user", fields: [{ name: "id", type: "string", nullable: false }, { name: "email", type: "string" }] },
      { name: "issue", primary_key: "id", semantic: "work.issue", fields: [
        { name: "id", type: "string", nullable: false }, { name: "title", type: "string" },
        { name: "assignee_id", type: "reference", reference: { object: "user" } }, { name: "spec", type: "attachment" },
      ] },
    ],
    relationships: [{ name: "assignee_issues", type: "one_to_many", from: { object: "user", field: "id" }, to: { object: "issue", field: "assignee_id" } }],
  };
  let readCalls = 0;
  const fake: Adapter<{ token: string }> = {
    platform: "fake", displayName: "Fake", version: "0.0.1",
    async connect(cfg) { assert.equal(cfg.token, "t"); return { platform: "fake", instance_id: "tenant-1" }; },
    async discover() { return schema; },
    async read(_cfg, object, ctx, cursor) {
      readCalls++;
      const start = (cursor as { n?: number } | undefined)?.n ?? 0;
      let last = start;
      async function* gen() {
        if (object === "user") { for (const i of [1, 2]) { yield { id: `u${i}`, email: `u${i}@x` }; last = i; } }
        else for (let i = start + 1; i <= 5; i++) {
          const spec = i === 1 ? await ctx.blob.add(Buffer.from(`spec ${i}`), { filename: `spec${i}.txt`, media_type: "text/plain" }) : null;
          yield { id: `i${i}`, title: `Issue ${i}`, assignee_id: i % 2 ? "u1" : "u2", spec };
          last = i;
        }
      }
      return { records: gen(), cursor: () => ({ n: last }) };
    },
  };
  const m = await runExport(fake, { token: "t" }, { out: dir, gzip: true, objects: ["user", "issue"] });
  assert.equal(m.stats!.records!.issue, 5);
  assert.equal(m.blobs!.length, 1);
  assert.deepEqual(m.export.cursor, { user: { n: 2 }, issue: { n: 5 } });
  assert.equal(m.source.adapter!.name, "@udmp/adapter-fake");
  assert.equal(readCalls, 2);

  const c = capture();
  assert.equal(await main(["validate", dir, "--json"], c.io), 0, c.out.join(""));
  const report = JSON.parse(c.out.join(""));
  assert.equal(report.effective_level, 3);
  rmSync(dir, { recursive: true });
});

test("score: computes the shipped scorecards", async () => {
  for (const f of ["hubspot", "linear"]) {
    const c = capture();
    const code = await main(["score", resolve(here, `../../../scorecards/${f}.json`)], c.io);
    assert.equal(code, 0, c.out.join("\n"));
    assert.match(c.out[0], /\/100\s+grade [A-F]/);
  }
});

test("validate: rejects a bundle whose manifest points outside itself", async () => {
  const dir = mkdtempSync(join(tmpdir(), "udmp-bad-"));
  writeFileSync(join(dir, "udmp-manifest.json"), JSON.stringify({
    udmp_version: "1.0.0", bundle_id: "7f8a3c2e-1b4d-4e6f-9a0b-2c3d4e5f6a7b", exported_at: "2026-11-15T04:00:00Z",
    source: { platform: "x" }, export: { mode: "full" }, conformance: { level: 1 },
    schema: { objects: [{ name: "t", primary_key: "id", fields: [{ name: "id", type: "string", nullable: false }] }] },
    data_files: [{ object: "t", format: "ndjson", files: [{ path: "../../etc/passwd", row_count: 1 }] }],
  }));
  const c = capture();
  assert.equal(await main(["validate", dir], c.io), 1);
  assert.match(c.out.join("\n"), /ERROR \[schema\]/);
  assert.ok(!existsSync(join(dir, "data")));
  rmSync(dir, { recursive: true });
});

test("import: --plan prints mapped and unmapped fields, --apply loads into a mocked Twenty tenant idempotently", async () => {
  const { fakeTwenty } = await import("../../adapter-twenty/test/fake-twenty.js");
  const real = globalThis.fetch;
  const t = fakeTwenty();
  globalThis.fetch = t.fetch;
  const dir = mkdtempSync(join(tmpdir(), "udmp-cli-import-"));
  try {
    const cfg = ["--config", "api_key=tw_test", "--config", "base_url=https://twenty.test"];
    let c = capture();
    assert.equal(await main(["import", sample, "--importer", "twenty", "--plan", "--plan-file", join(dir, "plan.json"), ...cfg], c.io), 0, c.err.join("\n"));
    const text = c.out.join("\n");
    assert.match(text, /account → companies\s+\[create, by semantic\]\s+crm\.account/);
    assert.match(text, /owner → workspaceMembers\s+\[lookup/);
    assert.match(text, /domain\s+string\s+→ domainName\.primaryLinkUrl/);
    assert.match(text, /cf_tshirt_size\s+enum\s+✗ unmapped → custom_field/);
    assert.match(text, /contract\s+attachment\s+✗ unmapped → json_note/);
    assert.ok(existsSync(join(dir, "plan.json")));
    assert.equal(t.store.companies.length, 0, "--plan writes nothing");

    c = capture();
    assert.equal(await main(["import", sample, "--importer", "twenty", "--apply", "--plan-file", join(dir, "plan.json"), "--id-map", join(dir, "ids.json"), "--quiet", ...cfg], c.io), 0, c.err.join("\n"));
    assert.match(c.out[0], /17 created, 1 already present, 1 skipped/);
    assert.equal(t.store.companies.length, 4);
    const ids = JSON.parse(readFileSync(join(dir, "ids.json"), "utf8"));
    assert.equal(Object.keys(ids.deal).length, 3);

    c = capture();
    assert.equal(await main(["import", sample, "--importer", "twenty", "--apply", "--quiet", ...cfg], c.io), 0);
    assert.match(c.out[0], /0 created, 18 already present/);
    assert.equal(t.store.companies.length, 4);
  } finally {
    globalThis.fetch = real;
    rmSync(dir, { recursive: true });
  }
});
