import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
