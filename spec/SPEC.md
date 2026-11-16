# UDMP 1.0 — Universal Data Migration Protocol

**Status:** Draft 1.0.0-rc.1
**Date:** 2026-11-15
**Editors:** Ayo Adesokan (@adesokanayo) and contributors
**License:** CC BY 4.0 (this document), Apache-2.0 (schemas and reference code)

---

## Abstract

UDMP defines a self-describing, streamable, relationally complete bundle format for moving the operational data of a software-as-a-service (SaaS) tenant out of one system and into another. A UDMP bundle carries its own schema, its relationships, its binary attachments and a normalized form of its rich text, so that an importer that has never seen the source system can still rebuild a faithful relational copy of the data.

The protocol has two halves:

1. **The Bundle Format** (Sections 4 to 10): what an export looks like on disk or on the wire.
2. **The Adapter Contract** (Section 11): how exporters and importers behave so that any adapter can feed any importer.

Together they turn an N×M migration problem (every source to every target) into an N+M problem (every source to UDMP, UDMP to every target).

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, RECOMMENDED, MAY and OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174.

---

## 1. Motivation

Code is cheap to reproduce. The durable advantage a SaaS vendor holds is the cost its customers would bear to leave. That cost is manufactured through flat CSV exports that drop relationships, rate-limited or paywalled APIs, expiring attachment URLs, and proprietary rich-text encodings.

Regulation is catching up. Chapter VI of the EU Data Act has applied to data processing services, SaaS included, since 12 September 2025, and from 12 January 2027 switching charges, including egress charges tied to switching, are banned outright. The law mandates the outcome (portability) but not the format. UDMP is a candidate for that format.

Prior art and why it is insufficient on its own:

| Prior art | What it gives | What it lacks for SaaS exit |
|---|---|---|
| Google / DTI Data Transfer Project | Cooperative vendor-to-vendor transfer for consumer data (photos, playlists) | Needs both vendors to opt in. No B2B relational model. |
| Frictionless Data Package v2 | Tabular descriptor with table schema and foreign keys | No attachments, rich text, custom-field semantics, incremental export or source provenance. |
| Singer / Airbyte protocols | Streaming record/state messages between tap and target | Wire protocols for pipelines, not an archival bundle. No relationship graph, no blobs. |
| Vendor "export all" ZIPs | Whatever the vendor chooses | Not self-describing, not comparable across vendors. |

UDMP borrows the Table Schema idea from Frictionless, the catalog idea from Airbyte, and adds what SaaS exit actually needs.

---

## 2. Terminology

- **Bundle**: a directory tree (or an archive of one) that conforms to this specification.
- **Manifest**: the root descriptor file, `udmp-manifest.json`.
- **Object**: a named collection of records sharing a schema. Equivalent to a table, entity type or stream.
- **Record**: one JSON object belonging to an object. Equivalent to a row.
- **Field**: a named, typed attribute of a record.
- **Relationship**: a declared link between two objects with a cardinality.
- **Blob**: a binary file stored inside the bundle and referenced from records.
- **Adapter**: software that exports from a source system into a bundle (an **exporter**) or imports from a bundle into a target (an **importer**).
- **Semantic tag**: an optional, namespaced label (for example `crm.contact`) that tells importers what an object or field *means*, independent of what the vendor called it.

---

## 3. Design Principles

1. **Self-describing.** A bundle MUST be interpretable with no knowledge of the source system beyond what the manifest states.
2. **Relational integrity first.** Every relationship MUST be declared, every foreign key MUST be typed, and a conforming bundle MUST be checkable for dangling references.
3. **Streamable.** Data files MUST be readable one record at a time with bounded memory. Nothing in the format requires loading an object into memory.
4. **Hydrated.** Attachments live in the bundle, not behind an expiring URL. Rich text has a portable Markdown form alongside the original.
5. **Lossless where possible, honest where not.** Anything that cannot be normalized is carried through verbatim in an `original` slot, and the manifest records what was dropped.
6. **Vendor-independent, vendor-honest.** Vendor field names are preserved. Semantic tags are added, not substituted.
7. **Boring on purpose.** JSON, NDJSON, SHA-256, Markdown, directories. No format that needs a special library to open.

---

## 4. Bundle Layout

```
<bundle>/
├── udmp-manifest.json          REQUIRED  root descriptor
├── udmp-manifest.yaml          OPTIONAL  YAML rendering of the same manifest
├── data/
│   └── <object>/
│       ├── 00001.ndjson        one or more chunks per object
│       ├── 00002.ndjson.gz     chunks MAY be gzip-compressed
│       └── ...
├── blobs/
│   └── sha256-<hex>[.<ext>]    content-addressed attachments
└── meta/
    ├── export.log              OPTIONAL  exporter log
    └── dropped.ndjson          OPTIONAL  records or fields the exporter could not carry
```

Rules:

- A bundle MUST contain `udmp-manifest.json` at its root.
- If `udmp-manifest.yaml` is present it MUST be semantically identical to the JSON manifest. Readers MUST support JSON and SHOULD support YAML. The JSON file is authoritative on conflict.
- Paths inside the manifest are relative to the bundle root, use `/` as separator, and MUST NOT contain `..` or begin with `/`.
- Data files for an object SHOULD live under `data/<object>/`. Chunk file names SHOULD be zero-padded integers so lexical order equals write order.
- A bundle MAY be distributed as a `.tar`, `.tar.gz` or `.zip` archive whose root is the bundle directory. The archive form carries no additional semantics.

---

## 5. The Manifest

The manifest is a JSON document validated by `schemas/udmp-manifest.schema.json` (JSON Schema 2020-12). This section states the semantics the schema cannot.

### 5.1 Top level

| Key | Req | Description |
|---|---|---|
| `udmp_version` | MUST | Semantic version of this specification the bundle conforms to, e.g. `"1.0.0"`. Readers MUST accept any `1.x.y`. |
| `bundle_id` | MUST | UUID (RFC 9562) unique to this export. |
| `exported_at` | MUST | RFC 3339 timestamp in UTC when the export began. |
| `source` | MUST | Provenance block, see 5.2. |
| `export` | MUST | Export mode and scope, see 5.3. |
| `schema` | MUST | Objects, fields and relationships, see 6 and 7. |
| `data_files` | MUST | Index of every data file, see 5.4. |
| `blobs` | SHOULD | Index of every blob, see 9. |
| `conformance` | MUST | Declared conformance level, see 12. |
| `stats` | MAY | Record counts and dropped counts. |
| `extensions` | MAY | Namespaced vendor or tool extensions. Keys MUST be reverse-DNS or `x-` prefixed. |

### 5.2 `source`

```json
"source": {
  "platform": "hubspot",
  "platform_display_name": "HubSpot",
  "instance_id": "portal_847291",
  "instance_url": "https://app.hubspot.com/contacts/847291",
  "region": "eu1",
  "adapter": { "name": "@udmp/adapter-hubspot", "version": "1.0.0" },
  "api_versions": { "crm": "v3", "associations": "v4" }
}
```

`platform` is a lowercase slug and is the only required key. `instance_id` SHOULD be whatever stable tenant identifier the platform exposes.

### 5.3 `export`

```json
"export": {
  "mode": "full",
  "since": null,
  "until": "2026-11-15T04:00:00Z",
  "objects_requested": ["account", "contact", "deal"],
  "objects_exported": ["account", "contact", "deal"],
  "cursor": { "contact": "2026-11-15T03:59:12Z" }
}
```

- `mode` is `full` or `incremental`.
- An `incremental` bundle MUST set `since` and MUST set `parent_bundle_id` to the `bundle_id` it continues. Importers MUST treat records in an incremental bundle as upserts keyed on the object's primary key, and MUST honour `deleted_at` (see 6.4).
- `cursor` is an opaque map an exporter MAY write and later read to resume.

### 5.4 `data_files`

```json
"data_files": [
  {
    "object": "contact",
    "format": "ndjson",
    "compression": "gzip",
    "files": [
      { "path": "data/contact/00001.ndjson.gz", "row_count": 5000, "bytes": 812331, "sha256": "..." },
      { "path": "data/contact/00002.ndjson.gz", "row_count": 3430, "bytes": 559010, "sha256": "..." }
    ]
  }
]
```

- Every file under `data/` MUST be listed exactly once.
- `format` MUST be `ndjson` in UDMP 1.0. `parquet` is reserved for 1.1 and readers MUST reject it until then.
- `compression` is `none` (default) or `gzip`.
- `sha256` is REQUIRED at conformance level 2 and above and is computed over the file bytes as stored (compressed if compressed).
- `row_count` MUST equal the number of records in the file.

---

## 6. Objects and Fields

### 6.1 Object

```json
{
  "name": "contact",
  "display_name": "Contacts",
  "semantic": "crm.contact",
  "primary_key": "id",
  "description": "People, optionally attached to a company.",
  "source_name": "contacts",
  "fields": [ ... ],
  "ordering": ["created_at"],
  "soft_delete_field": "deleted_at"
}
```

- `name` MUST match `^[a-z][a-z0-9_]{0,63}$` and MUST be unique within the bundle.
- `primary_key` MUST name a field in `fields` that is non-nullable. Composite keys are expressed as an array of field names.
- `semantic` is OPTIONAL and, if present, SHOULD be a term from `spec/VOCABULARY.md` or a namespaced custom term (`x-acme.widget`).
- `source_name` preserves the vendor's own name for the object.

### 6.2 Field

```json
{ "name": "cf_annual_contract_value", "type": "decimal", "nullable": true,
  "is_custom": true, "source_name": "annual_contract_value__c",
  "semantic": "crm.deal.amount", "display_name": "Annual Contract Value" }
```

- `name` MUST match `^[a-z_][a-z0-9_]{0,127}$` and MUST be unique within the object.
- Custom (user-defined, non-standard) fields SHOULD be prefixed `cf_` and MUST set `is_custom: true`.
- `nullable` defaults to `true`. The primary key field(s) MUST be `nullable: false`.
- `type` is one of the types in 6.3.
- Fields of type `reference` MUST carry `reference: { "object": "<object name>" }` and SHOULD also appear in a declared relationship (Section 7).
- Fields of type `enum` MUST carry `enum: { "values": [ { "value": "open", "label": "Open" }, ... ] }`.
- Fields of type `array` MUST carry `items: { "type": "<scalar type>" }`.

### 6.3 Type System

| Type | JSON encoding | Notes |
|---|---|---|
| `string` | string | Unicode, no length limit. |
| `integer` | number or string | Integers outside ±2^53 MUST be encoded as a decimal string. |
| `decimal` | string | Arbitrary-precision decimal as a string, e.g. `"1234.50"`. Never a JSON number. |
| `float` | number | IEEE 754 double. |
| `boolean` | boolean | |
| `date` | string | RFC 3339 full-date, `YYYY-MM-DD`. |
| `datetime` | string | RFC 3339 date-time with offset, normalized to `Z` where the source gives no zone. |
| `time` | string | RFC 3339 partial-time. |
| `duration` | string | ISO 8601 duration, e.g. `"PT90M"`. |
| `currency` | object | `{ "amount": "<decimal string>", "code": "USD" }`. |
| `enum` | string | One of the declared `values`. Unknown values MUST be carried through, not dropped, and SHOULD be logged. |
| `reference` | string or array | Primary key value of a record in `reference.object`. Arrays express many-to-many on the owning side. |
| `json` | any | Opaque structured data the exporter could not type further. |
| `richtext` | object | See Section 8. |
| `attachment` | object | See Section 9. |
| `geo` | object | `{ "lat": <float>, "lon": <float> }`. |
| `array` | array | Homogeneous array of the `items` type. |

A `null` JSON value is valid for any nullable field.

### 6.4 Reserved record fields

Records MAY carry these fields without declaring them. If declared, they MUST have the types shown.

| Field | Type | Meaning |
|---|---|---|
| `created_at` | datetime | Source creation time. |
| `updated_at` | datetime | Source last-modified time. |
| `deleted_at` | datetime | Set when the record was soft-deleted at the source. Importers MUST NOT silently drop such records in a `full` export; they SHOULD import them as deleted. |
| `_source` | json | Verbatim source payload, when the exporter chooses to carry it. |

---

## 7. Relationships

```json
"relationships": [
  { "name": "account_contacts", "type": "one_to_many",
    "from": { "object": "account", "field": "id" },
    "to":   { "object": "contact", "field": "account_id" },
    "on_delete": "set_null" },

  { "name": "deal_contacts", "type": "many_to_many",
    "from": { "object": "deal", "field": "id" },
    "to":   { "object": "contact", "field": "id" },
    "through": { "object": "deal_contact", "from_field": "deal_id", "to_field": "contact_id" } }
]
```

- `type` is `one_to_one`, `one_to_many` or `many_to_many`.
- For `one_to_one` and `one_to_many`, `to.field` MUST be a field of type `reference` whose `reference.object` equals `from.object`, and `from.field` MUST be that object's primary key.
- For `many_to_many`, `through.object` MUST be a declared object whose `from_field` and `to_field` are `reference` fields pointing at `from.object` and `to.object` respectively. The junction object MAY carry additional fields.
- `on_delete` is advisory for importers: `set_null`, `cascade` or `restrict`. Default `set_null`.
- Polymorphic references (a field that may point at several objects) MUST be modelled as a separate `reference` field per target object, or as a `json` field plus an explicit note in `description`. UDMP 1.0 does not define a polymorphic reference type.

### 7.1 Referential integrity

A bundle at conformance level 2 or above MUST satisfy: for every `reference` value in every record, a record with that primary key exists in the referenced object within the same bundle (or, for incremental bundles, in the parent chain). Exporters that cannot satisfy this MUST either emit the referenced record or write the dangling reference to `meta/dropped.ndjson` and null the field.

---

## 8. Rich Text

Vendors store formatted text in HTML, Atlassian Document Format, ProseMirror JSON, Slack mrkdwn, Quill deltas and more. A `richtext` value normalizes this:

```json
{
  "markdown": "Call with **Jane** on Monday.\n\n- Follow up on pricing\n- Send [contract](blob:sha256-8f92a1...)",
  "plain": "Call with Jane on Monday. Follow up on pricing. Send contract",
  "original": { "format": "html", "content": "<p>Call with <b>Jane</b> ..." },
  "mentions": [ { "object": "user", "id": "u_12", "label": "Jane" } ]
}
```

- `markdown` is REQUIRED and MUST be CommonMark with GFM tables, strikethrough and task lists permitted.
- `original` SHOULD be present and carries the source encoding verbatim. `format` is a lowercase slug (`html`, `adf`, `prosemirror`, `mrkdwn`, `quill`, `tiptap`, `markdown`, `plain`).
- Inline images and file links that point at bundled blobs MUST use the `blob:` URI scheme: `blob:sha256-<hex>`.
- `mentions` is OPTIONAL and lists references to other records the text mentions, so importers can re-link them.

---

## 9. Blobs and Attachments

An `attachment` value:

```json
{
  "blob": "sha256-8f92a1c4e2...",
  "filename": "contract.pdf",
  "media_type": "application/pdf",
  "bytes": 184233,
  "source_url": "https://cdn.example.com/f/abc?token=expired-by-tomorrow",
  "fetched_at": "2026-11-15T04:02:11Z",
  "status": "ok"
}
```

- `blob` is the content address: `sha256-` followed by the lowercase hex SHA-256 of the file bytes. The file lives at `blobs/<blob>[.<ext>]`. The optional extension is a convenience for humans; readers MUST locate blobs by prefix match on `blobs/<blob>`.
- Identical files are stored once. Two attachments with the same hash share a blob.
- `status` is `ok`, `skipped` (exporter chose not to fetch, e.g. size cap) or `failed` (fetch attempted, failed). On `skipped` or `failed`, `blob` MUST be null and `source_url` SHOULD be present.
- The manifest `blobs` index lists every file under `blobs/` with `bytes`, `media_type` and `sha256`.
- Exporters SHOULD respect a configurable per-file size cap and total cap, and MUST record what they skipped.

---

## 10. Data Files

- A data file is newline-delimited JSON (NDJSON): one record per line, UTF-8, `\n` terminated, no BOM.
- Every record MUST be a JSON object containing the primary key field(s) with non-null values.
- Records of one object MAY be split over many chunks. Chunks SHOULD be capped at 50 MB uncompressed or 100 000 records, whichever comes first.
- Records SHOULD be ordered by primary key or by `ordering`, if declared. Readers MUST NOT rely on order.
- Undeclared fields in a record are permitted but SHOULD be logged by validators as warnings. Exporters SHOULD instead declare them as `json` typed fields.

---

## 11. Adapter Contract

An adapter is a program or library. UDMP does not mandate a language. The reference implementation defines TypeScript interfaces; this section defines the behaviours that any implementation MUST share.

### 11.1 Exporter

An exporter MUST implement three operations:

| Operation | Input | Output |
|---|---|---|
| `discover` | connection config | A `schema` block (objects, fields, relationships) describing what this tenant actually has, including custom fields. |
| `read` | config, object name, optional cursor | A stream of records for that object, in any order, plus a final cursor. |
| `fetch_blob` | config, a source attachment reference | The bytes and media type of the attachment, or a `skipped`/`failed` status. |

Rules:

- `discover` MUST be run against the live tenant, never from a static schema, because custom fields differ per tenant.
- `read` MUST be resumable: given the cursor it last returned, it MUST continue without re-emitting records already emitted.
- Exporters MUST respect the source's rate limits and MUST back off on HTTP 429 and 5xx. They MUST NOT spoof user agents, bypass authentication, or scrape rendered UIs. UDMP adapters use the APIs the vendor already gives its customers.
- Exporters MUST emit referenced records before or alongside referencing records when running under a relational-conformance target, or defer integrity to a post-pass that nulls or drops dangling references and records them in `meta/dropped.ndjson`.

### 11.2 Importer

An importer MUST implement:

| Operation | Input | Output |
|---|---|---|
| `plan` | manifest | A mapping proposal: which bundle objects/fields land where in the target, which are unmapped. Uses `semantic` tags first, falls back to names. |
| `apply` | bundle, approved plan | Writes records to the target in dependency order and returns an id map (`{ object: { source_id: target_id } }`). |

Rules:

- Importers MUST load objects in topological order of `one_to_many` and `one_to_one` relationships, then junction objects.
- Importers MUST rewrite `reference` values through the id map when the target assigns new ids.
- Importers MUST NOT drop unmapped fields silently; they MUST surface them in the plan and SHOULD offer to store them as custom fields or JSON.
- Importers MUST be idempotent for the same `bundle_id`: re-applying a bundle MUST NOT create duplicates.

### 11.3 Packaging convention (reference implementation)

- npm package name: `@udmp/adapter-<platform>` or `udmp-adapter-<platform>`.
- Default export: an object satisfying `Adapter` from `@udmp/core`.
- The package MUST declare `udmp.platform` and `udmp.udmp_version` in its `package.json`.

---

## 12. Conformance Levels

A bundle declares one level. Each level includes the previous.

| Level | Name | Requirements |
|---|---|---|
| 1 | **Schema** | Valid manifest. Every record has a primary key. Every declared field has the declared type or null. |
| 2 | **Relational** | Level 1 plus: all relationships declared, no dangling references (7.1), `sha256` on every data file, `row_count` accurate. |
| 3 | **Hydrated** | Level 2 plus: every attachment is `ok` or recorded as `skipped`/`failed` with a `source_url`; every `richtext` has `markdown` and `original`; `blobs` index is complete. |

A validator MUST be able to verify a claimed level and MUST downgrade the effective level on failure rather than reject the bundle outright, so partial exports remain usable.

---

## 13. Versioning and Extensions

- The spec follows semantic versioning. Minor versions add optional keys and types; readers MUST ignore unknown keys. Major versions may break.
- Tool-specific data goes under `extensions` with a namespaced key. Readers MUST ignore extensions they do not understand.
- Proposals for new types, semantic terms or conformance rules are made as pull requests to this repository and tracked as UDMP Improvement Proposals (UIPs) in `spec/uips/`.

---

## 14. Security and Privacy Considerations

- A bundle is a complete copy of a tenant's business data. It MUST be treated as sensitive. Exporters SHOULD offer encryption at rest for the bundle directory and MUST never write credentials into the manifest or logs.
- `source_url` values often contain signed tokens. Exporters SHOULD strip query strings from `source_url` after a successful fetch.
- Importers MUST validate every path in the manifest against traversal (`..`, absolute paths) before touching the filesystem.
- Exporters operate as the authenticated customer using the vendor's documented API. Nothing in this protocol authorizes circumventing access controls, and adapters that do so are non-conforming.

---

## 15. Relationship to Regulation

UDMP is designed so that a provider who exports in it can demonstrate the technical half of the EU Data Act's switching obligations (Articles 25, 30) and GDPR Article 20 portability: structured, commonly used, machine-readable, with relationships intact. UDMP does not itself make a legal claim; it is a format.

---

## Appendix A — Minimal valid manifest

```json
{
  "udmp_version": "1.0.0",
  "bundle_id": "7f8a3c2e-1b4d-4e6f-9a0b-2c3d4e5f6a7b",
  "exported_at": "2026-11-15T04:00:00Z",
  "source": { "platform": "example" },
  "export": { "mode": "full" },
  "conformance": { "level": 1 },
  "schema": {
    "objects": [
      { "name": "thing", "primary_key": "id",
        "fields": [ { "name": "id", "type": "string", "nullable": false } ] }
    ],
    "relationships": []
  },
  "data_files": [
    { "object": "thing", "format": "ndjson",
      "files": [ { "path": "data/thing/00001.ndjson", "row_count": 1 } ] }
  ]
}
```

## Appendix B — Mapping guide for common vendor concepts

| Vendor concept | UDMP modelling |
|---|---|
| HubSpot associations | `many_to_many` with a junction object per association type, or `reference` arrays on the owning object. |
| Jira issue links | Junction object `issue_link` with `link_type` enum. |
| Linear issue → parent issue | `one_to_many` self-reference: `parent_id` is a `reference` to `issue`. |
| Zendesk ticket comments with attachments | `comment.body` as `richtext`; `comment.attachments` as `array` of `attachment`. |
| Salesforce picklists | `enum` with `values` from `describe`. |
| Shopify metafields | `cf_` prefixed fields typed from the metafield definition, `json` fallback. |
