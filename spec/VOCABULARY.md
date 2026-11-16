# UDMP Semantic Vocabulary 1.0

Semantic tags let an importer that has never seen HubSpot recognise that `companies` are accounts and `hs_deal_stage` is a pipeline stage. They are **hints, not a schema**: an object keeps its vendor field names and gains a tag.

Tags are dot-separated, lowercase. The first segment is a domain. Object tags have two segments (`crm.contact`); field tags have three (`crm.contact.email`). Custom tags MUST start with `x-` and a reverse-DNS or org slug (`x-acme.widget`).

A field tag's object segment is advisory: `crm.deal.amount` may legitimately appear on an object tagged `commerce.order`.

## Common field tags (any domain)

| Tag | Meaning |
|---|---|
| `common.id` | Primary identifier |
| `common.name` | Human display name |
| `common.title` | Short title |
| `common.description` | Long description, usually richtext |
| `common.created_at` / `common.updated_at` / `common.deleted_at` | Lifecycle timestamps |
| `common.created_by` / `common.updated_by` | Reference to `identity.user` |
| `common.owner` | Reference to the responsible `identity.user` |
| `common.status` | Enum state |
| `common.tags` | Array of string labels |
| `common.url` | Canonical URL at source |
| `common.external_id` | Identifier in some other system |

## `identity`

| Object | Fields |
|---|---|
| `identity.user` | `.email`, `.display_name`, `.avatar`, `.is_active`, `.role` |
| `identity.team` | `.key`, `.members` |
| `identity.organization` | `.domain` |

## `crm`

| Object | Fields |
|---|---|
| `crm.account` | `.domain`, `.industry`, `.employee_count`, `.annual_revenue`, `.phone`, `.address`, `.lifecycle_stage` |
| `crm.contact` | `.email`, `.first_name`, `.last_name`, `.phone`, `.job_title`, `.account`, `.lifecycle_stage`, `.lead_source` |
| `crm.lead` | same as contact, plus `.converted_to` |
| `crm.deal` | `.amount`, `.currency`, `.stage`, `.pipeline`, `.close_date`, `.probability`, `.account`, `.primary_contact`, `.is_won`, `.is_lost` |
| `crm.pipeline` | `.stages` |
| `crm.pipeline_stage` | `.order`, `.probability`, `.is_closed` |
| `crm.activity` | `.kind` (call, email, meeting, note, task), `.body`, `.occurred_at`, `.related_to` |
| `crm.note` | `.body` |
| `crm.task` | `.due_at`, `.is_complete`, `.assignee` |
| `crm.product` | `.sku`, `.price` |
| `crm.line_item` | `.product`, `.quantity`, `.unit_price`, `.deal` |

## `work` (project and issue tracking)

| Object | Fields |
|---|---|
| `work.workspace` | |
| `work.project` | `.key`, `.lead`, `.start_date`, `.target_date`, `.state` |
| `work.issue` | `.key`, `.state`, `.priority`, `.assignee`, `.reporter`, `.parent`, `.project`, `.labels`, `.estimate`, `.due_date`, `.cycle`, `.completed_at` |
| `work.issue_state` | `.category` (backlog, todo, in_progress, done, cancelled), `.order` |
| `work.label` | `.color` |
| `work.cycle` | `.number`, `.starts_at`, `.ends_at` |
| `work.comment` | `.body`, `.author`, `.issue`, `.parent` |
| `work.attachment` | `.file`, `.issue` |
| `work.issue_link` | `.from`, `.to`, `.kind` (blocks, duplicates, relates) |
| `work.milestone` | `.due_date` |

## `support`

| Object | Fields |
|---|---|
| `support.ticket` | `.subject`, `.status`, `.priority`, `.requester`, `.assignee`, `.channel`, `.group`, `.tags`, `.satisfaction` |
| `support.message` | `.body`, `.author`, `.ticket`, `.is_public`, `.attachments` |
| `support.requester` | same as `crm.contact` |
| `support.article` | `.body`, `.section`, `.is_published` |
| `support.macro` | |

## `commerce`

| Object | Fields |
|---|---|
| `commerce.customer` | `.email`, `.orders_count`, `.total_spent`, `.accepts_marketing` |
| `commerce.product` | `.sku`, `.price`, `.inventory`, `.variants`, `.images` |
| `commerce.variant` | `.product`, `.sku`, `.price`, `.options` |
| `commerce.order` | `.number`, `.customer`, `.total`, `.subtotal`, `.tax`, `.shipping`, `.currency`, `.financial_status`, `.fulfillment_status`, `.placed_at` |
| `commerce.line_item` | `.order`, `.variant`, `.quantity`, `.unit_price` |
| `commerce.fulfillment` | `.order`, `.tracking_number`, `.carrier` |
| `commerce.refund` | `.order`, `.amount` |
| `commerce.discount` | `.code`, `.kind`, `.value` |

## `finance`

| Object | Fields |
|---|---|
| `finance.invoice` | `.number`, `.customer`, `.total`, `.currency`, `.due_date`, `.status` |
| `finance.payment` | `.invoice`, `.amount`, `.method`, `.paid_at` |
| `finance.subscription` | `.customer`, `.plan`, `.status`, `.current_period_end` |
| `finance.expense` | `.amount`, `.category`, `.submitted_by` |

## `hr`

| Object | Fields |
|---|---|
| `hr.employee` | `.email`, `.manager`, `.department`, `.start_date`, `.end_date`, `.employment_type` |
| `hr.department` | `.head` |
| `hr.time_off` | `.employee`, `.kind`, `.starts_at`, `.ends_at`, `.status` |

## `docs` (knowledge and content)

| Object | Fields |
|---|---|
| `docs.page` | `.body`, `.parent`, `.space`, `.is_published` |
| `docs.space` | |
| `docs.comment` | `.body`, `.page`, `.author` |
| `docs.file` | `.file`, `.folder` |
| `docs.folder` | `.parent` |

## `messaging`

| Object | Fields |
|---|---|
| `messaging.channel` | `.is_private`, `.members` |
| `messaging.message` | `.body`, `.author`, `.channel`, `.thread_parent`, `.reactions`, `.attachments` |

## Adding terms

Open a pull request editing this file. A term is accepted when two independent adapters would use it. Terms are never removed in a 1.x release; they may be marked deprecated.
