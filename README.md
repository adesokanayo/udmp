# UDMP — Universal Data Migration Protocol

**An open bundle format and adapter contract for taking your data out of any SaaS, relationships and attachments intact, and putting it into any other.**

Code is a commodity now. The last moat a SaaS vendor has is the pain of leaving: flat CSV exports that drop every relationship, rate-limited or paywalled APIs, attachment links that expire tomorrow, rich text in a format nobody else reads. UDMP removes that moat.

- **Spec:** [spec/SPEC.md](spec/SPEC.md) — the normative format, 15 sections.
- **Vocabulary:** [spec/VOCABULARY.md](spec/VOCABULARY.md) — semantic tags so an importer that has never seen HubSpot knows a `company` is a `crm.account`.
- **Exit Score:** [spec/EXIT-SCORE.md](spec/EXIT-SCORE.md) — a public 100-point index of how hard each vendor makes it to leave.
- **Schema:** [schemas/udmp-manifest.schema.json](schemas/udmp-manifest.schema.json) — JSON Schema 2020-12.
- **Reference implementation:** `packages/` — TypeScript, Apache-2.0.

Status: **1.0.0-rc.1**. The format is stable enough to build on; the adapter surface may still move before 1.0.0.

## The idea in one picture

```
   HubSpot ─┐                              ┌─▶ Attio
   Jira ────┤   exporters    ┌────────┐    importers   ├─▶ Linear
   Zendesk ─┼──────────────▶ │  UDMP  │ ───────────────┼─▶ Plane
   Shopify ─┤                │ bundle │                ├─▶ your own Postgres
   ...  ────┘                └────────┘                └─▶ SQLite on your laptop
       N adapters                                        M adapters
```

N sources plus M targets instead of N × M point-to-point migrations. The same move that the Model Context Protocol made for AI tool integration, applied to the data itself.

## What a bundle looks like

```
export_bundle/
├── udmp-manifest.json      schema, relationships, file index, provenance, checksums
├── udmp-manifest.yaml      same thing, for humans
├── data/
│   ├── account/00001.ndjson
│   ├── contact/00001.ndjson
│   └── deal_contact/00001.ndjson     junction object for many-to-many
├── blobs/
│   └── sha256-a8d5d8…f8.pdf          content-addressed attachments
└── meta/
    └── dropped.ndjson                anything the exporter could not carry
```

Every object declares its primary key, every field its type, every relationship its cardinality. Custom fields are first-class (`cf_` prefix, `is_custom: true`). Rich text is Markdown with the original preserved. Attachments are downloaded into the bundle and referenced by hash. See [examples/hubspot-sample](examples/hubspot-sample).

Three conformance levels: **Schema** (valid and typed), **Relational** (no dangling references, checksummed), **Hydrated** (attachments and rich text in the bundle). `udmp validate` tells you which one you actually have.

## Try it

```bash
pnpm install && pnpm build
```

```bash
node packages/cli/dist/bin.js validate examples/hubspot-sample
```

```bash
node packages/cli/dist/bin.js inspect examples/hubspot-sample
```

```bash
node packages/cli/dist/bin.js to-sqlite examples/hubspot-sample crm.sqlite
```

Then open `crm.sqlite` in anything and run:

```sql
SELECT d.dealname, c.email
FROM deal d JOIN deal_contact dc ON dc.deal_id = d.id JOIN contact c ON c.id = dc.contact_id
WHERE dc.label = '7';  -- "Decision maker"
```

## Export your own tenant

```bash
UDMP_LINEAR_API_KEY=lin_api_… node packages/cli/dist/bin.js export --adapter linear --out ./linear-backup --gzip
```

```bash
UDMP_HUBSPOT_ACCESS_TOKEN=pat-… node packages/cli/dist/bin.js export --adapter hubspot --out ./hubspot-backup
```

Adapters use only the documented, customer-facing API with your own credentials. They back off on rate limits and never write a credential into the bundle. Run the export on a weekly cron into SQLite and you own a queryable copy of your own data before you ever need to switch, which changes the conversation at renewal time.

## Packages

| Package | What |
|---|---|
| `@udmp/core` | Types, manifest validation, streaming bundle reader/writer, integrity checker, export runner, SQLite importer, rich-text normalizers, Exit Score. |
| `udmp` | CLI: `validate`, `inspect`, `export`, `to-sqlite`, `score`. |
| `@udmp/adapter-linear` | Linear exporter (GraphQL). Static schema, Markdown-native. |
| `@udmp/adapter-hubspot` | HubSpot CRM exporter. Dynamic schema: discovers custom properties, enums, association labels per tenant. |

## Why not …

- **Data Transfer Project?** Cooperative and consumer-focused: it needs both vendors to build a bridge. UDMP adapters work from the customer side with the APIs that already exist.
- **Frictionless Data Package?** Great for tables; no attachments, rich text, custom-field semantics, incremental exports or source provenance. UDMP borrows its table-schema shape.
- **Airbyte / Singer?** Pipeline wire protocols, not an archival bundle, and no relationship graph. An Airbyte destination for UDMP would be a fine thing to build.
- **The vendor's own export?** Not self-describing, not comparable, and usually flat.

## Regulation

Chapter VI of the EU Data Act has applied to SaaS since September 2025; from **12 January 2027** switching and egress charges tied to switching are banned. The law requires portability in a structured, machine-readable form but names no format. UDMP is one.

## Governance

Neutral home, no vendor ownership, adversarial to lock-in but never to a vendor's people or terms of service. See [GOVERNANCE.md](GOVERNANCE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap to 1.0.0

- [ ] Reference **importer** for a challenger (Attio or Twenty) to prove the M side.
- [ ] OpenAPI-to-adapter scaffolder so a new SaaS adapter is an afternoon's work.
- [ ] Parquet chunk format (reserved in 1.0, lands in 1.1).
- [ ] Jira, Zendesk, Shopify, Pipedrive, Intercom adapters, with scorecards.
- [ ] Public Exit Score site generated from `scorecards/`.
- [ ] Conformance test suite as a published fixture set.
