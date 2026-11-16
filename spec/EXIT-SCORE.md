# The SaaS Exit Score

A public, reproducible 100-point index of how hard a vendor makes it to leave. Scored per vendor, per plan tier, from the perspective of a paying customer using only documented, supported means.

Scores live in `scorecards/<platform>.json` and are validated and computed by `udmp score`. Every claim in a scorecard MUST cite a public URL (docs, pricing page, changelog) or a dated reproduction. Vendors may dispute by pull request.

## Five criteria, 20 points each

### 1. API Access (0–20)
Can a customer reach all of their data through an API without paying extra?

| Points | Condition |
|---|
| 20 | Full read API on every plan, no paywall, no per-object gating. |
| 15 | Full read API on every plan but rate limits make a full export take more than 24 h for a mid-size tenant (100k records). |
| 10 | Read API exists but some objects (e.g. attachments, audit log, custom objects) need a higher tier. |
| 5 | Read API only on enterprise or add-on plans. |
| 0 | No public read API, or API access is revoked at cancellation before export. |

### 2. Schema Introspection (0–20)
Can software discover the tenant's actual schema, including custom fields, enums and relationships?

| Points | Condition |
|---|
| 20 | Live endpoint returns objects, fields, types, enum values and association/relationship definitions. |
| 15 | Fields and types are discoverable; relationships must be inferred from docs. |
| 10 | Custom fields discoverable, types absent or untyped (everything is a string). |
| 5 | Schema only in human documentation. |
| 0 | Custom fields not discoverable at all. |

### 3. Relational Integrity (0–20)
Do exports preserve links between records?

| Points | Condition |
|---|
| 20 | Every relationship is exposed with stable ids on both sides and is enumerable in bulk. |
| 15 | Relationships available but only per-record (N+1 calls). |
| 10 | Some relationships available; others (e.g. activity-to-deal) are not exposed. |
| 5 | Built-in export is flat CSV; relationships recoverable only via API with significant effort. |
| 0 | Relationships are not recoverable. |

### 4. Export Throughput (0–20)
How long does a complete export of a mid-size tenant take?

| Points | Condition |
|---|
| 20 | Bulk export endpoint or async job; full export under 1 h. |
| 15 | Paginated API; full export under 6 h. |
| 10 | Full export 6–24 h. |
| 5 | Full export over 24 h, or requires support ticket. |
| 0 | Export throttled to make completion impractical, or capped. |

### 5. Attachment and Rich-Text Portability (0–20)
Can binaries and formatted text be retrieved in a usable form?

| Points | Condition |
|---|
| 20 | Attachments downloadable via API with stable auth; rich text available as HTML or Markdown or a documented open format. |
| 15 | Attachments downloadable but via short-lived signed URLs that must be refreshed; rich text in a documented format. |
| 10 | Attachments downloadable; rich text only in a proprietary undocumented format. |
| 5 | Attachments require UI download one by one. |
| 0 | Attachments not retrievable, or rich text not retrievable. |

## Grades

| Score | Grade |
|---|---|
| 90–100 | A — Open. Leaving is a weekend project. |
| 75–89 | B — Fair. |
| 60–74 | C — Sticky. |
| 40–59 | D — Captive. |
| 0–39 | F — Hostage. |

## Modifiers (do not change the score, shown alongside)

- **Data Act flag**: vendor has published a Data Act switching procedure.
- **UDMP native**: vendor ships a first-party UDMP exporter (`+` badge) or importer (`↓` badge).
- **Cancellation grace**: days of API access retained after cancellation.

## Scorecard format

```json
{
  "platform": "hubspot",
  "display_name": "HubSpot",
  "plan": "Professional",
  "scored_at": "2026-11-15",
  "scored_by": "@adesokanayo",
  "criteria": {
    "api_access":            { "points": 15, "evidence": ["https://..."], "notes": "..." },
    "schema_introspection":  { "points": 20, "evidence": ["https://..."] },
    "relational_integrity":  { "points": 15, "evidence": ["https://..."] },
    "export_throughput":     { "points": 15, "evidence": ["https://..."] },
    "attachment_portability":{ "points": 15, "evidence": ["https://..."] }
  },
  "modifiers": { "data_act_procedure": false, "udmp_native_export": false, "udmp_native_import": false, "cancellation_grace_days": null }
}
```
