import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport, validateBundle, BundleReader } from "@udmp/core";
import adapter from "../src/index.js";

/**
 * Recorded-fixture test: a fake Linear GraphQL endpoint that paginates, includes an
 * archived issue, a parent/child issue, a comment thread, an external attachment
 * (skipped) and an uploads.linear.app attachment (fetched). No network.
 */
const users = [{ id: "u1", name: "Ada", displayName: "ada", email: "ada@x", active: true, admin: true, avatarUrl: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", archivedAt: null }];
const teams = [{ id: "t1", key: "ENG", name: "Engineering", description: null, private: false, timezone: "UTC", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", archivedAt: null }];
const states = [{ id: "s1", name: "Todo", color: "#000", type: "unstarted", position: 1, team: { id: "t1" }, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", archivedAt: null }];
const labels = [{ id: "l1", name: "bug", color: "#f00", description: null, team: { id: "t1" }, parent: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", archivedAt: null }];
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `i${n}`, identifier: `ENG-${n}`, number: n, title: `Issue ${n}`, description: n === 1 ? "# Hello\n\nworld" : null, priority: 2, priorityLabel: "High", estimate: null,
  team: { id: "t1" }, state: { id: "s1" }, assignee: { id: "u1" }, creator: { id: "u1" }, parent: n === 2 ? { id: "i1" } : null, project: null, cycle: null,
  labels: { nodes: n === 1 ? [{ id: "l1" }] : [] }, dueDate: n === 1 ? "2026-12-01" : null, url: `https://linear.app/x/issue/ENG-${n}`, branchName: `eng-${n}`, sortOrder: n,
  createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z", archivedAt: n === 3 ? "2025-02-01T00:00:00.000Z" : null,
  startedAt: null, completedAt: null, canceledAt: null, autoClosedAt: null, snoozedUntilAt: null, ...extra,
});
const issues = [issue(1), issue(2), issue(3)];
const comments = [
  { id: "c1", body: "first", issue: { id: "i1" }, user: { id: "u1" }, parent: null, url: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", editedAt: null, archivedAt: null },
  { id: "c2", body: "reply", issue: { id: "i1" }, user: { id: "u1" }, parent: { id: "c1" }, url: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", editedAt: null, archivedAt: null },
];
const attachments = [
  { id: "a1", title: "PR #12", subtitle: null, url: "https://github.com/x/y/pull/12", sourceType: "github", issue: { id: "i1" }, creator: { id: "u1" }, metadata: {}, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", archivedAt: null },
  { id: "a2", title: "design.png", subtitle: null, url: "https://uploads.linear.app/abc/design.png", sourceType: null, issue: { id: "i1" }, creator: { id: "u1" }, metadata: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", archivedAt: null },
];
const relations = [{ id: "r1", issue: { id: "i1" }, relatedIssue: { id: "i2" }, type: "blocks", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" }];
const DATA: Record<string, unknown[]> = { users, teams, workflowStates: states, issueLabels: labels, projects: [], cycles: [], issues, comments, attachments, issueRelations: relations };

function fakeFetch(): typeof fetch {
  return mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://uploads.linear.app/abc/design.png") {
      assert.equal((init?.headers as Record<string, string>).authorization, "lin_api_test");
      return new Response(Buffer.from("PNGBYTES"), { headers: { "content-type": "image/png" } });
    }
    assert.equal(url, "https://api.linear.app/graphql");
    assert.equal((init?.headers as Record<string, string>).authorization, "lin_api_test");
    const { query, variables } = JSON.parse(String(init?.body));
    if (/organization/.test(query)) return Response.json({ data: { organization: { id: "org1", name: "X", urlKey: "x" } } });
    const root = /^\s*query[^{]*\{\s*(\w+)\(/.exec(query)![1];
    assert.match(query, /includeArchived: true/);
    const all = DATA[root];
    const first = variables.first as number;
    const start = variables.after ? Number(variables.after) : 0;
    const nodes = all.slice(start, start + first);
    const end = start + nodes.length;
    return Response.json({ data: { [root]: { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } } });
  }) as unknown as typeof fetch;
}

test("linear adapter exports a conformant level-3 bundle from a recorded tenant", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  const dir = mkdtempSync(join(tmpdir(), "udmp-linear-"));
  try {
    const m = await runExport(adapter, { api_key: "lin_api_test", page_size: "2" }, { out: dir });
    assert.equal(m.source.instance_url, "https://linear.app/x");
    assert.equal(m.stats!.records!.issue, 3);
    assert.equal(m.stats!.blobs_ok, 1);
    assert.equal(m.stats!.blobs_skipped, 1);
    assert.deepEqual(m.export.cursor!.issue, { after: "3", since: undefined });

    const r = new BundleReader(dir);
    const recs = [];
    for await (const x of r.records("issue")) recs.push(x);
    assert.equal(recs[0].description && (recs[0].description as { markdown: string }).markdown, "# Hello\n\nworld");
    assert.deepEqual(recs[0].label_ids, ["l1"]);
    assert.equal(recs[1].parent_id, "i1");
    assert.equal(recs[2].archived_at, "2025-02-01T00:00:00.000Z"); // soft-deleted kept (§6.4)

    const atts = [];
    for await (const x of r.records("attachment")) atts.push(x);
    assert.equal((atts[0].file as { status: string }).status, "skipped");
    assert.equal((atts[1].file as { status: string; blob: string }).status, "ok");
    assert.ok(r.blobPath((atts[1].file as { blob: string }).blob)!.endsWith(".png"));

    const report = await validateBundle(dir);
    assert.equal(report.ok, true, JSON.stringify(report.issues, null, 1));
    assert.equal(report.effective_level, 3);
    assert.ok(["user", "team"].every((o) => r.topologicalOrder().indexOf(o) < r.topologicalOrder().indexOf("issue")));
    assert.equal(r.topologicalOrder().at(-1), "issue_relation");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true });
  }
});

test("linear adapter refuses to run without an api key", async () => {
  await assert.rejects(() => adapter.connect({ api_key: "" }), /api_key is required/);
});
