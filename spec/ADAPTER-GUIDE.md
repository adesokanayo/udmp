# Writing a UDMP Adapter

An exporter adapter is a few hundred lines. The runner in `@udmp/core` handles chunking, checksums, blobs, cursors, the manifest, and conformance; you handle talking to the source.

## 1. The interface

```ts
import type { Adapter } from "@udmp/core";

export const adapter: Adapter<MyConfig> = {
  platform: "myapp",            // lowercase slug; becomes source.platform
  displayName: "MyApp",
  version: "1.0.0",

  async connect(config) {       // validate credentials, return provenance
    return { platform: "myapp", instance_id: "tenant-123", instance_url: "https://myapp.example/t/123" };
  },

  async discover(config, ctx) { // live schema, including custom fields
    return { objects: [...], relationships: [...] };
  },

  async read(config, object, ctx, cursor) {  // stream one object, resumable
    return { records: asyncIterable, cursor: () => lastCursor };
  },

  async fetchBlob(config, ref, ctx) {        // optional
    return fetchBlobToBundle(ctx, ref, { authorization: `Bearer ${config.token}` });
  },
};
export default adapter;
```

Run it with `runExport(adapter, config, { out })` or `udmp export --adapter myapp`.

## 2. Modelling rules of thumb

- **One UDMP object per source entity type.** Keep the vendor's field names (snake-cased) and put the original in `source_name`.
- **Custom fields:** `cf_` prefix, `is_custom: true`, type from the vendor's field definition. Fall back to `json` rather than guessing.
- **References:** any field holding another record's id is `type: "reference"` with `reference.object`. Declare the matching relationship.
- **Many-to-many:** emit a junction object (`is_junction: true`) with two reference fields and an `id` you construct (`"${a}:${b}:${label}"` works).
- **Enums:** copy the vendor's option list into `enum.values`; leave `open: true` so unknown values survive.
- **Timestamps:** RFC 3339 with `Z`. Epoch millis → `new Date(n).toISOString()`.
- **Money:** `decimal` strings or `currency` objects. Never floats.
- **Rich text:** `richTextFromHtml`, `richTextFromMarkdown`, `richTextFromAdf` in `@udmp/core`.
- **Soft deletes:** keep archived records and set `deleted_at`; declare `soft_delete_field`.
- **Semantic tags:** add them from `spec/VOCABULARY.md` for the obvious objects and fields. This is what lets an importer map your output without knowing your vendor.

## 3. Behaviour rules (normative, spec §11.1)

- Use the documented API with the customer's own credentials. No UI scraping, no auth bypass.
- Back off on 429 and 5xx. `fetchWithRetry` does this and honours `Retry-After`.
- Be resumable: return a cursor from `read` and accept it back.
- Never put a credential in a record, the manifest, or a log line.
- Strip signed tokens from `source_url` (the runner's blob helper does this).

## 4. Tests without credentials

Record a tiny tenant as fixtures and stub `globalThis.fetch` (see `packages/adapter-linear/test`). Assert that `validateBundle` reports the level you claim. CI never touches the network.

## 5. Ship it

- Package name `@udmp/adapter-<platform>` or `udmp-adapter-<platform>`.
- `package.json` carries `"udmp": { "platform": "<slug>", "udmp_version": "1.0.0" }`.
- Default export is the adapter.
- Add `scorecards/<platform>.json` with evidence links.
- Open a PR to list it in the registry.

## 6. Writing an importer (spec §11.2)

An importer is the other half of N+M: it reads a bundle it has never seen and lands it in a target, using `semantic` tags rather than vendor knowledge. `@udmp/adapter-twenty` is the reference.

```ts
import type { Importer } from "@udmp/core";

export const importer: Importer<MyConfig> = {
  platform: "myapp", displayName: "MyApp", version: "1.0.0",
  async connect(config) { /* validate credentials, describe the tenant */ },
  async plan(config, manifest, ctx) { /* read target metadata, propose a MappingPlan, write nothing */ },
  async apply(config, bundle, plan, ctx) { /* write in plan.order, return { id_map, created, matched, ... } */ },
};
export default importer;
```

Run it with `udmp import <bundle> --importer myapp --plan` (prints the plan and exits) and `--apply`.

**The plan.** Match objects by their `semantic` tag first (`crm.account` → your "company"), then by name. Do the same per field. Every field that lands nowhere MUST still appear in the plan with a `disposition`: `custom_field` (create it on the target when `options.create_custom_fields` is true), `json_note` (keep the value in an attached note or JSON column), or `skip` with a reason. `formatPlan()` renders it; `--plan-file` lets an operator edit the JSON before `--apply`.

**Apply.**
- Walk `plan.order`, which is `BundleReader.topologicalOrder()`: referenced objects first, junction objects last.
- Rewrite references with `rewriteReferences(obj, record, id_map)` before writing; it returns dangling references so you can surface them instead of dropping them.
- Many-to-many junctions become whatever the target has: a native link, a custom link object, or a note. Say which in the plan.
- Lookup-only objects (`identity.user` → workspace members) resolve into the id map by email and are never created.
- Be idempotent: write `<platform>:<object>:<source_id>` into an external-id field on every target record and read it back before creating. A second `apply` of the same bundle MUST create nothing. Soft-deleted source records (`soft_delete_field`) SHOULD be soft-deleted on the target, not skipped.

**Tests.** Stub `globalThis.fetch` with an in-memory tenant (`packages/adapter-twenty/test/fake-twenty.ts`), import `examples/hubspot-sample`, and assert the id map, the junction links, and that a second apply makes no write calls.
