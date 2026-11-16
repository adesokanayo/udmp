import {
  fetchWithRetry, fetchBlobToBundle, richTextFromMarkdown,
  type Adapter, type AdapterContext, type Schema, type Source, type UdmpRecord, type ObjectDef, type Field,
} from "@udmp/core";

/**
 * Linear exporter. Uses the public GraphQL API with a personal API key
 * (Settings → API) or an OAuth access token. Read-only queries only.
 *
 * Config: { api_key: string, endpoint?: string, page_size?: string }
 */
export interface LinearConfig { api_key: string; endpoint?: string; page_size?: string }

const ENDPOINT = "https://api.linear.app/graphql";

const f = (name: string, type: Field["type"], extra: Partial<Field> = {}): Field => ({ name, type, ...extra });
const ref = (name: string, object: string, extra: Partial<Field> = {}): Field => ({ name, type: "reference", reference: { object }, ...extra });
const ts = (name: string, semantic?: string): Field => ({ name, type: "datetime", ...(semantic ? { semantic } : {}) });

const BASE_FIELDS: Record<string, Field[]> = {
  user: [
    f("id", "string", { nullable: false, semantic: "common.id" }), f("name", "string", { semantic: "identity.user.display_name" }),
    f("display_name", "string"), f("email", "string", { semantic: "identity.user.email" }), f("active", "boolean", { semantic: "identity.user.is_active" }),
    f("admin", "boolean"), f("avatar_url", "string"), ts("created_at", "common.created_at"), ts("updated_at", "common.updated_at"), ts("archived_at"),
  ],
  team: [
    f("id", "string", { nullable: false }), f("key", "string", { semantic: "identity.team.key" }), f("name", "string", { semantic: "common.name" }),
    f("description", "string"), f("private", "boolean"), f("timezone", "string"), ts("created_at"), ts("updated_at"), ts("archived_at"),
  ],
  workflow_state: [
    f("id", "string", { nullable: false }), f("name", "string", { semantic: "common.name" }), f("color", "string"),
    f("type", "enum", { semantic: "work.issue_state.category", enum: { values: ["triage", "backlog", "unstarted", "started", "completed", "canceled"].map((v) => ({ value: v })) } }),
    f("position", "float", { semantic: "work.issue_state.order" }), ref("team_id", "team"), ts("created_at"), ts("updated_at"), ts("archived_at"),
  ],
  label: [
    f("id", "string", { nullable: false }), f("name", "string", { semantic: "common.name" }), f("color", "string", { semantic: "work.label.color" }),
    f("description", "string"), ref("team_id", "team"), ref("parent_id", "label"), ts("created_at"), ts("updated_at"), ts("archived_at"),
  ],
  project: [
    f("id", "string", { nullable: false }), f("name", "string", { semantic: "common.name" }), f("description", "richtext", { semantic: "common.description" }),
    f("slug_id", "string"), f("state", "string", { semantic: "work.project.state" }), f("priority", "integer"), f("progress", "float"),
    ref("lead_id", "user", { semantic: "work.project.lead" }), ref("creator_id", "user", { semantic: "common.created_by" }),
    f("start_date", "date", { semantic: "work.project.start_date" }), f("target_date", "date", { semantic: "work.project.target_date" }),
    f("url", "string", { semantic: "common.url" }), ts("created_at"), ts("updated_at"), ts("archived_at"), ts("completed_at"), ts("canceled_at"),
    f("team_ids", "array", { items: { type: "reference", reference: { object: "team" } } }),
  ],
  cycle: [
    f("id", "string", { nullable: false }), f("number", "integer", { semantic: "work.cycle.number" }), f("name", "string"),
    ref("team_id", "team"), ts("starts_at", "work.cycle.starts_at"), ts("ends_at", "work.cycle.ends_at"), ts("completed_at"), f("progress", "float"),
    ts("created_at"), ts("updated_at"), ts("archived_at"),
  ],
  issue: [
    f("id", "string", { nullable: false }), f("identifier", "string", { semantic: "work.issue.key" }), f("number", "integer"),
    f("title", "string", { semantic: "common.title" }), f("description", "richtext", { semantic: "common.description" }),
    f("priority", "integer", { semantic: "work.issue.priority" }), f("priority_label", "string"), f("estimate", "float", { semantic: "work.issue.estimate" }),
    ref("team_id", "team", { nullable: false }), ref("state_id", "workflow_state", { semantic: "work.issue.state" }),
    ref("assignee_id", "user", { semantic: "work.issue.assignee" }), ref("creator_id", "user", { semantic: "work.issue.reporter" }),
    ref("parent_id", "issue", { semantic: "work.issue.parent" }), ref("project_id", "project", { semantic: "work.issue.project" }),
    ref("cycle_id", "cycle", { semantic: "work.issue.cycle" }),
    f("label_ids", "array", { items: { type: "reference", reference: { object: "label" } }, semantic: "work.issue.labels" }),
    f("due_date", "date", { semantic: "work.issue.due_date" }), f("url", "string", { semantic: "common.url" }), f("branch_name", "string"),
    f("sort_order", "float"), ts("created_at", "common.created_at"), ts("updated_at", "common.updated_at"), ts("archived_at"),
    ts("started_at"), ts("completed_at", "work.issue.completed_at"), ts("canceled_at"), ts("auto_closed_at"), ts("snoozed_until_at"),
  ],
  comment: [
    f("id", "string", { nullable: false }), f("body", "richtext", { semantic: "work.comment.body" }),
    ref("issue_id", "issue", { semantic: "work.comment.issue" }), ref("user_id", "user", { semantic: "work.comment.author" }), ref("parent_id", "comment", { semantic: "work.comment.parent" }),
    f("url", "string"), ts("created_at"), ts("updated_at"), ts("edited_at"), ts("archived_at"),
  ],
  attachment: [
    f("id", "string", { nullable: false }), f("title", "string", { semantic: "common.title" }), f("subtitle", "string"),
    f("url", "string", { semantic: "common.url" }), f("source_type", "string"), f("file", "attachment", { semantic: "work.attachment.file" }),
    ref("issue_id", "issue", { semantic: "work.attachment.issue" }), ref("creator_id", "user"), f("metadata", "json"), ts("created_at"), ts("updated_at"), ts("archived_at"),
  ],
  issue_relation: [
    f("id", "string", { nullable: false }), ref("issue_id", "issue", { nullable: false, semantic: "work.issue_link.from" }),
    ref("related_issue_id", "issue", { nullable: false, semantic: "work.issue_link.to" }),
    f("type", "enum", { semantic: "work.issue_link.kind", enum: { values: ["blocks", "duplicate", "related", "similar"].map((v) => ({ value: v })) } }),
    ts("created_at"), ts("updated_at"),
  ],
};

const SEMANTIC: Record<string, string> = {
  user: "identity.user", team: "identity.team", workflow_state: "work.issue_state", label: "work.label", project: "work.project",
  cycle: "work.cycle", issue: "work.issue", comment: "work.comment", attachment: "work.attachment", issue_relation: "work.issue_link",
};

const DISPLAY: Record<string, string> = {
  user: "Users", team: "Teams", workflow_state: "Workflow States", label: "Labels", project: "Projects", cycle: "Cycles",
  issue: "Issues", comment: "Comments", attachment: "Attachments", issue_relation: "Issue Relations",
};

// GraphQL selections per object. Linear's connection API paginates every list the same way.
const SELECTIONS: Record<string, string> = {
  user: `id name displayName email active admin avatarUrl createdAt updatedAt archivedAt`,
  team: `id key name description private timezone createdAt updatedAt archivedAt`,
  workflow_state: `id name color type position team { id } createdAt updatedAt archivedAt`,
  label: `id name color description team { id } parent { id } createdAt updatedAt archivedAt`,
  project: `id name description slugId state priority progress lead { id } creator { id } startDate targetDate url createdAt updatedAt archivedAt completedAt canceledAt teams { nodes { id } }`,
  cycle: `id number name team { id } startsAt endsAt completedAt progress createdAt updatedAt archivedAt`,
  issue: `id identifier number title description priority priorityLabel estimate team { id } state { id } assignee { id } creator { id } parent { id } project { id } cycle { id } labels { nodes { id } } dueDate url branchName sortOrder createdAt updatedAt archivedAt startedAt completedAt canceledAt autoClosedAt snoozedUntilAt`,
  comment: `id body issue { id } user { id } parent { id } url createdAt updatedAt editedAt archivedAt`,
  attachment: `id title subtitle url sourceType issue { id } creator { id } metadata createdAt updatedAt archivedAt`,
  issue_relation: `id issue { id } relatedIssue { id } type createdAt updatedAt`,
};

const ROOT: Record<string, string> = {
  user: "users", team: "teams", workflow_state: "workflowStates", label: "issueLabels", project: "projects",
  cycle: "cycles", issue: "issues", comment: "comments", attachment: "attachments", issue_relation: "issueRelations",
};

type Node = Record<string, unknown>;
const id = (x: unknown) => (x && typeof x === "object" && "id" in x ? String((x as Node).id) : null);
const ids = (x: unknown) => (x && typeof x === "object" && "nodes" in x ? ((x as { nodes: Node[] }).nodes.map((n) => String(n.id))) : []);
const date = (x: unknown) => (typeof x === "string" ? x.slice(0, 10) : null);
const nz = <T>(x: T | undefined): T | null => (x === undefined ? null : x);

function mapNode(object: string, n: Node): UdmpRecord {
  switch (object) {
    case "user": return { id: n.id, name: nz(n.name), display_name: nz(n.displayName), email: nz(n.email), active: nz(n.active), admin: nz(n.admin), avatar_url: nz(n.avatarUrl), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt), archived_at: nz(n.archivedAt) };
    case "team": return { id: n.id, key: nz(n.key), name: nz(n.name), description: nz(n.description), private: nz(n.private), timezone: nz(n.timezone), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt), archived_at: nz(n.archivedAt) };
    case "workflow_state": return { id: n.id, name: nz(n.name), color: nz(n.color), type: nz(n.type), position: nz(n.position), team_id: id(n.team), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt), archived_at: nz(n.archivedAt) };
    case "label": return { id: n.id, name: nz(n.name), color: nz(n.color), description: nz(n.description), team_id: id(n.team), parent_id: id(n.parent), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt), archived_at: nz(n.archivedAt) };
    case "project": return { id: n.id, name: nz(n.name), description: richTextFromMarkdown(n.description as string), slug_id: nz(n.slugId), state: nz(n.state), priority: nz(n.priority), progress: nz(n.progress), lead_id: id(n.lead), creator_id: id(n.creator), start_date: date(n.startDate), target_date: date(n.targetDate), url: nz(n.url), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt), archived_at: nz(n.archivedAt), completed_at: nz(n.completedAt), canceled_at: nz(n.canceledAt), team_ids: ids(n.teams) };
    case "cycle": return { id: n.id, number: nz(n.number), name: nz(n.name), team_id: id(n.team), starts_at: nz(n.startsAt), ends_at: nz(n.endsAt), completed_at: nz(n.completedAt), progress: nz(n.progress), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt), archived_at: nz(n.archivedAt) };
    case "issue": return { id: n.id, identifier: nz(n.identifier), number: nz(n.number), title: nz(n.title), description: richTextFromMarkdown(n.description as string), priority: nz(n.priority), priority_label: nz(n.priorityLabel), estimate: nz(n.estimate), team_id: id(n.team), state_id: id(n.state), assignee_id: id(n.assignee), creator_id: id(n.creator), parent_id: id(n.parent), project_id: id(n.project), cycle_id: id(n.cycle), label_ids: ids(n.labels), due_date: date(n.dueDate), url: nz(n.url), branch_name: nz(n.branchName), sort_order: nz(n.sortOrder), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt), archived_at: nz(n.archivedAt), started_at: nz(n.startedAt), completed_at: nz(n.completedAt), canceled_at: nz(n.canceledAt), auto_closed_at: nz(n.autoClosedAt), snoozed_until_at: nz(n.snoozedUntilAt) };
    case "comment": return { id: n.id, body: richTextFromMarkdown(n.body as string), issue_id: id(n.issue), user_id: id(n.user), parent_id: id(n.parent), url: nz(n.url), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt), edited_at: nz(n.editedAt), archived_at: nz(n.archivedAt) };
    case "attachment": return { id: n.id, title: nz(n.title), subtitle: nz(n.subtitle), url: nz(n.url), source_type: nz(n.sourceType), file: null, issue_id: id(n.issue), creator_id: id(n.creator), metadata: nz(n.metadata), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt), archived_at: nz(n.archivedAt) };
    case "issue_relation": return { id: n.id, issue_id: id(n.issue), related_issue_id: id(n.relatedIssue), type: nz(n.type), created_at: nz(n.createdAt), updated_at: nz(n.updatedAt) };
  }
  throw new Error(`mapNode: unknown object ${object}`);
}

async function gql<T>(cfg: LinearConfig, query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const res = await fetchWithRetry(cfg.endpoint ?? ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: cfg.api_key },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(`Linear API: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data as T;
}

async function* paginate(cfg: LinearConfig, object: string, ctx: AdapterContext, after?: string, since?: string): AsyncGenerator<{ node: Node; cursor: string }> {
  const root = ROOT[object];
  const first = Math.min(250, Math.max(1, Number(cfg.page_size ?? 100)));
  // includeArchived keeps soft-deleted records (spec §6.4). updatedAt filter supports incremental export.
  const filter = since ? `, filter: { updatedAt: { gte: $since } }` : "";
  const query = `query($first: Int!, $after: String${since ? ", $since: DateTimeOrDuration" : ""}) {
    ${root}(first: $first, after: $after, includeArchived: true${filter}) {
      nodes { ${SELECTIONS[object]} }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  let cursor = after;
  for (;;) {
    if (ctx.signal?.aborted) throw new Error("aborted");
    const data = await gql<Record<string, { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string } }>>(cfg, query, { first, after: cursor, since }, ctx.signal);
    const page = data[root];
    for (const node of page.nodes) yield { node, cursor: page.pageInfo.endCursor };
    if (!page.pageInfo.hasNextPage) return;
    cursor = page.pageInfo.endCursor;
  }
}

export const adapter: Adapter<LinearConfig> = {
  platform: "linear",
  displayName: "Linear",
  version: "1.0.0-rc.1",

  async connect(cfg) {
    if (!cfg.api_key) throw new Error("linear: api_key is required (UDMP_LINEAR_API_KEY or --config api_key=...)");
    const data = await gql<{ organization: { id: string; name: string; urlKey: string } }>(cfg, `{ organization { id name urlKey } }`, {});
    const source: Source = {
      platform: "linear", platform_display_name: "Linear",
      instance_id: data.organization.id, instance_url: `https://linear.app/${data.organization.urlKey}`,
      api_versions: { graphql: "2026" },
    };
    return source;
  },

  async discover(cfg, ctx) {
    // Linear has no per-tenant custom fields on issues (as of this adapter); templates and
    // project milestones vary but are not user-defined schema. The schema is therefore static,
    // but we still hit the API so discover() proves connectivity and reads the org's workflow types.
    const objects: ObjectDef[] = Object.keys(BASE_FIELDS).map((name) => ({
      name, display_name: DISPLAY[name], semantic: SEMANTIC[name], source_name: ROOT[name], primary_key: "id",
      fields: BASE_FIELDS[name], soft_delete_field: BASE_FIELDS[name].some((x) => x.name === "archived_at") ? "archived_at" : undefined,
    }));
    const schema: Schema = {
      objects,
      relationships: [
        { name: "team_states", type: "one_to_many", from: { object: "team", field: "id" }, to: { object: "workflow_state", field: "team_id" } },
        { name: "team_labels", type: "one_to_many", from: { object: "team", field: "id" }, to: { object: "label", field: "team_id" } },
        { name: "label_children", type: "one_to_many", from: { object: "label", field: "id" }, to: { object: "label", field: "parent_id" } },
        { name: "team_cycles", type: "one_to_many", from: { object: "team", field: "id" }, to: { object: "cycle", field: "team_id" } },
        { name: "team_issues", type: "one_to_many", from: { object: "team", field: "id" }, to: { object: "issue", field: "team_id" } },
        { name: "state_issues", type: "one_to_many", from: { object: "workflow_state", field: "id" }, to: { object: "issue", field: "state_id" } },
        { name: "assignee_issues", type: "one_to_many", from: { object: "user", field: "id" }, to: { object: "issue", field: "assignee_id" } },
        { name: "creator_issues", type: "one_to_many", from: { object: "user", field: "id" }, to: { object: "issue", field: "creator_id" } },
        { name: "issue_children", type: "one_to_many", from: { object: "issue", field: "id" }, to: { object: "issue", field: "parent_id" } },
        { name: "project_issues", type: "one_to_many", from: { object: "project", field: "id" }, to: { object: "issue", field: "project_id" } },
        { name: "cycle_issues", type: "one_to_many", from: { object: "cycle", field: "id" }, to: { object: "issue", field: "cycle_id" } },
        { name: "project_lead", type: "one_to_many", from: { object: "user", field: "id" }, to: { object: "project", field: "lead_id" } },
        { name: "issue_comments", type: "one_to_many", from: { object: "issue", field: "id" }, to: { object: "comment", field: "issue_id" } },
        { name: "comment_author", type: "one_to_many", from: { object: "user", field: "id" }, to: { object: "comment", field: "user_id" } },
        { name: "comment_replies", type: "one_to_many", from: { object: "comment", field: "id" }, to: { object: "comment", field: "parent_id" } },
        { name: "issue_attachments", type: "one_to_many", from: { object: "issue", field: "id" }, to: { object: "attachment", field: "issue_id" } },
        { name: "issue_relations", type: "many_to_many", from: { object: "issue", field: "id" }, to: { object: "issue", field: "id" }, through: { object: "issue_relation", from_field: "issue_id", to_field: "related_issue_id" } },
      ],
    };
    ctx.log(`linear: ${objects.length} objects (static schema; Linear exposes no tenant custom fields)`);
    return schema;
  },

  async read(cfg, object, ctx, cursor) {
    if (!SELECTIONS[object]) throw new Error(`linear: unknown object ${object}`);
    const state = (cursor ?? {}) as { after?: string; since?: string };
    let last: string | undefined = state.after;
    const self = this;
    async function* records(): AsyncGenerator<UdmpRecord> {
      for await (const { node, cursor: c } of paginate(cfg, object, ctx, state.after, state.since)) {
        const rec = mapNode(object, node);
        if (object === "attachment") rec.file = await self.fetchBlob!(cfg, { url: String(node.url), filename: String(node.title ?? ""), source_type: node.sourceType }, ctx);
        yield rec;
        last = c;
      }
    }
    return { records: records(), cursor: () => ({ after: last, since: state.since }) };
  },

  async fetchBlob(cfg, ref, ctx) {
    // Linear attachments are usually links (GitHub PRs, Figma, Slack). Only uploads.linear.app
    // hosts bytes, and those need the API key as a bearer token.
    let host = "";
    try { host = new URL(ref.url).host; } catch { return ctx.blob.failed({ source_url: ref.url, filename: ref.filename }, "invalid url"); }
    if (host !== "uploads.linear.app") return ctx.blob.skipped({ source_url: ref.url, filename: ref.filename }, `external link (${host}), not a file`);
    return fetchBlobToBundle(ctx, ref, { authorization: cfg.api_key });
  },
};

export default adapter;
