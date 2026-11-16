import type { BundleReader } from "./bundle.js";
import type { Field, Manifest, ObjectDef, UdmpRecord } from "./types.js";

/**
 * Importer contract (spec §11.2). An importer proposes a mapping (`plan`),
 * the operator approves or edits it, then `apply` writes the bundle into the
 * target in dependency order and returns an id map.
 */

/** Where an unmapped field goes if the operator approves the plan as proposed. */
export type UnmappedDisposition = "custom_field" | "json_note" | "skip";

export interface FieldMapping {
  /** Bundle field name. */
  source: string;
  /** Bundle field type. */
  type: Field["type"];
  /** Bundle semantic tag, if any. */
  semantic?: string;
  /** Target field path (dot-separated for nested inputs), or null when unmapped. */
  target: string | null;
  /** Human-readable description of the value transform, if any. */
  transform?: string;
  /** How the match was made. */
  matched_by?: "semantic" | "name" | "custom";
  /** For unmapped fields: what apply() will do with the value. */
  disposition?: UnmappedDisposition;
  /** Why the field is unmapped, partial, or transformed. */
  reason?: string;
}

export interface ObjectMapping {
  source: string;
  semantic?: string;
  /** Target object (plural API name for Twenty, table for SQL, …), or null when the object is not mapped. */
  target: string | null;
  /** create: write records. lookup: resolve ids against existing target records only. skip: not imported. */
  mode: "create" | "lookup" | "skip";
  matched_by?: "semantic" | "name" | "none";
  fields: FieldMapping[];
  reason?: string;
}

export interface MappingPlan {
  importer: string;
  importer_version: string;
  bundle_id: string;
  source_platform: string;
  /** Load order: topological order of the bundle (spec §11.2). */
  order: string[];
  objects: ObjectMapping[];
  /** Operator-editable switches honoured by apply(). */
  options: {
    /** Create target custom fields/objects for `custom_field` dispositions. When false they fall back to `json_note`. */
    create_custom_fields: boolean;
    /** Field used on the target to store the bundle's source id (idempotency key). */
    external_id_field: string;
  };
}

/** `{ object: { source_id: target_id } }` */
export type IdMap = Record<string, Record<string, string>>;

export interface ImportContext {
  log: (msg: string) => void;
  signal?: AbortSignal;
}

export interface ImportResult {
  id_map: IdMap;
  /** Records created per bundle object. */
  created: Record<string, number>;
  /** Records that already existed in the target for this source id and were reused. */
  matched: Record<string, number>;
  /** Records that could not be written (dangling lookups etc.). */
  skipped: Record<string, number>;
  /** Target custom fields/objects created by this run. */
  custom_fields_created: string[];
  /** Overflow notes written for json_note dispositions. */
  notes_created: number;
}

export interface Importer<C = Record<string, unknown>> {
  /** Target platform slug, e.g. "twenty". */
  platform: string;
  displayName: string;
  version: string;
  /** Validate config and return a description of the target tenant. */
  connect(config: C): Promise<{ platform: string; instance_url?: string; [k: string]: unknown }>;
  /** Propose a mapping from the bundle manifest to the target. Reads target metadata; writes nothing. */
  plan(config: C, manifest: Manifest, ctx: ImportContext): Promise<MappingPlan>;
  /** Write the bundle into the target according to an approved plan. Idempotent per bundle_id. */
  apply(config: C, bundle: BundleReader, plan: MappingPlan, ctx: ImportContext): Promise<ImportResult>;
}

/** Fields of `obj` that hold references (scalar or array), for id-map rewriting. */
export function referenceFields(obj: ObjectDef): Array<{ field: Field; object: string; array: boolean }> {
  const out: Array<{ field: Field; object: string; array: boolean }> = [];
  for (const f of obj.fields) {
    if (f.type === "reference" && f.reference) out.push({ field: f, object: f.reference.object, array: false });
    else if (f.type === "array" && f.items?.type === "reference" && f.items.reference) out.push({ field: f, object: f.items.reference.object, array: true });
  }
  return out;
}

/**
 * Rewrite every reference value in `rec` through the id map (spec §11.2).
 * References whose target has no mapping become null and are reported in `dangling`.
 */
export function rewriteReferences(obj: ObjectDef, rec: UdmpRecord, idMap: IdMap): { record: UdmpRecord; dangling: Array<{ field: string; object: string; source_id: string }> } {
  const record: UdmpRecord = { ...rec };
  const dangling: Array<{ field: string; object: string; source_id: string }> = [];
  for (const { field, object, array } of referenceFields(obj)) {
    const v = rec[field.name];
    if (v === null || v === undefined) continue;
    const map = idMap[object] ?? {};
    const one = (id: unknown): string | null => {
      const hit = map[String(id)];
      if (hit === undefined) { dangling.push({ field: field.name, object, source_id: String(id) }); return null; }
      return hit;
    };
    record[field.name] = array ? (Array.isArray(v) ? v.map(one).filter((x) => x !== null) : []) : one(v);
  }
  return { record, dangling };
}

/** Render a plan as a readable table for `udmp import --plan`. */
export function formatPlan(plan: MappingPlan): string {
  const lines: string[] = [];
  lines.push(`import plan: bundle ${plan.bundle_id} (${plan.source_platform}) → ${plan.importer} v${plan.importer_version}`);
  lines.push(`load order: ${plan.order.join(" → ")}`);
  lines.push(`options: create_custom_fields=${plan.options.create_custom_fields}  external_id_field=${plan.options.external_id_field}`);
  let unmapped = 0;
  for (const o of plan.objects) {
    lines.push("");
    const head = o.target ? `${o.source} → ${o.target}  [${o.mode}${o.matched_by ? ", by " + o.matched_by : ""}]` : `${o.source} → (unmapped)  [${o.mode}]`;
    lines.push(`${head}${o.semantic ? "  " + o.semantic : ""}${o.reason ? "  — " + o.reason : ""}`);
    for (const f of o.fields) {
      const left = `  ${f.source.padEnd(28)} ${f.type.padEnd(10)}`;
      if (f.target) lines.push(`${left} → ${f.target}${f.transform ? "  (" + f.transform + ")" : ""}${f.reason ? "  — " + f.reason : ""}`);
      else { unmapped++; lines.push(`${left} ✗ unmapped → ${f.disposition ?? "skip"}${f.reason ? "  — " + f.reason : ""}`); }
    }
  }
  lines.push("");
  lines.push(`${unmapped} unmapped field(s); dispositions are honoured by --apply (custom_field needs create_custom_fields=true, otherwise json_note).`);
  return lines.join("\n");
}
