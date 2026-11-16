import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";
import type { Manifest, ObjectDef, Field } from "./types.js";

export const MANIFEST_JSON = "udmp-manifest.json";
export const MANIFEST_YAML = "udmp-manifest.yaml";

export interface Issue {
  level: "error" | "warning";
  code: string;
  path?: string;
  message: string;
}

function schemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/manifest.js -> ../schema/ ; src/manifest.ts -> ../../../schemas/
  const candidates = [
    join(here, "..", "schema", "udmp-manifest.schema.json"),
    join(here, "..", "..", "..", "schemas", "udmp-manifest.schema.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("udmp-manifest.schema.json not found");
}

type Validator = ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };
let _validate: Validator | null = null;

function compiled(): Validator {
  if (_validate) return _validate;
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
  const af = addFormats as unknown as { default?: (a: Ajv2020) => void } & ((a: Ajv2020) => void);
  (af.default ?? af)(ajv);
  const schema = JSON.parse(readFileSync(schemaPath(), "utf8"));
  _validate = ajv.compile(schema) as unknown as Validator;
  return _validate;
}

/** Structural validation against the JSON Schema. */
export function validateManifestShape(data: unknown): Issue[] {
  const v = compiled();
  if (v(data)) return [];
  return (v.errors ?? []).map((e) => ({
    level: "error",
    code: "schema",
    path: e.instancePath || "/",
    message: `${e.instancePath || "/"} ${e.message ?? ""}${e.params ? " " + JSON.stringify(e.params) : ""}`.trim(),
  }));
}

/** Cross-reference checks the JSON Schema cannot express. */
export function validateManifestSemantics(m: Manifest): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, path: string, message: string) => issues.push({ level: "error", code, path, message });
  const warn = (code: string, path: string, message: string) => issues.push({ level: "warning", code, path, message });

  const objects = new Map<string, ObjectDef>();
  m.schema.objects.forEach((o, i) => {
    if (objects.has(o.name)) err("dup_object", `/schema/objects/${i}`, `duplicate object "${o.name}"`);
    objects.set(o.name, o);
  });

  for (const [oi, o] of m.schema.objects.entries()) {
    const fields = new Map<string, Field>();
    o.fields.forEach((f, fi) => {
      if (fields.has(f.name)) err("dup_field", `/schema/objects/${oi}/fields/${fi}`, `duplicate field "${o.name}.${f.name}"`);
      fields.set(f.name, f);
      if (f.type === "reference" && f.reference && !objects.has(f.reference.object))
        err("bad_reference", `/schema/objects/${oi}/fields/${fi}`, `${o.name}.${f.name} references unknown object "${f.reference.object}"`);
      if (f.type === "array" && f.items?.type === "reference" && f.items.reference && !objects.has(f.items.reference.object))
        err("bad_reference", `/schema/objects/${oi}/fields/${fi}`, `${o.name}.${f.name}[] references unknown object "${f.items.reference.object}"`);
      if (f.is_custom && !f.name.startsWith("cf_"))
        warn("custom_prefix", `/schema/objects/${oi}/fields/${fi}`, `custom field ${o.name}.${f.name} should be prefixed cf_`);
    });
    const pks = Array.isArray(o.primary_key) ? o.primary_key : [o.primary_key];
    for (const pk of pks) {
      const f = fields.get(pk);
      if (!f) err("pk_missing", `/schema/objects/${oi}`, `primary key "${pk}" is not a field of "${o.name}"`);
      else if (f.nullable !== false) err("pk_nullable", `/schema/objects/${oi}`, `primary key ${o.name}.${pk} must be nullable:false`);
    }
    if (o.soft_delete_field && !fields.has(o.soft_delete_field))
      err("soft_delete_missing", `/schema/objects/${oi}`, `soft_delete_field "${o.soft_delete_field}" not in ${o.name}`);
    for (const ord of o.ordering ?? []) if (!fields.has(ord)) err("ordering_missing", `/schema/objects/${oi}`, `ordering field "${ord}" not in ${o.name}`);
  }

  const fieldOf = (obj: string, f: string) => objects.get(obj)?.fields.find((x) => x.name === f);
  for (const [ri, r] of (m.schema.relationships ?? []).entries()) {
    const p = `/schema/relationships/${ri}`;
    for (const end of ["from", "to"] as const) {
      if (!objects.has(r[end].object)) { err("rel_object", p, `${r.name}: ${end}.object "${r[end].object}" unknown`); continue; }
      if (!fieldOf(r[end].object, r[end].field)) err("rel_field", p, `${r.name}: ${end}.field "${r[end].object}.${r[end].field}" unknown`);
    }
    if (r.type !== "many_to_many") {
      const toF = fieldOf(r.to.object, r.to.field);
      if (toF && toF.type !== "reference") err("rel_to_not_ref", p, `${r.name}: to.field must be type reference`);
      if (toF?.type === "reference" && toF.reference?.object !== r.from.object)
        err("rel_ref_mismatch", p, `${r.name}: ${r.to.object}.${r.to.field} references "${toF.reference?.object}", expected "${r.from.object}"`);
      const fromObj = objects.get(r.from.object);
      const fromPks = fromObj ? (Array.isArray(fromObj.primary_key) ? fromObj.primary_key : [fromObj.primary_key]) : [];
      if (fromObj && !fromPks.includes(r.from.field)) err("rel_from_not_pk", p, `${r.name}: from.field must be the primary key of ${r.from.object}`);
    } else if (r.through) {
      const j = objects.get(r.through.object);
      if (!j) { err("rel_through", p, `${r.name}: through.object "${r.through.object}" unknown`); continue; }
      const ff = fieldOf(j.name, r.through.from_field), tf = fieldOf(j.name, r.through.to_field);
      if (!ff || ff.type !== "reference" || ff.reference?.object !== r.from.object)
        err("rel_through_from", p, `${r.name}: ${j.name}.${r.through.from_field} must be a reference to ${r.from.object}`);
      if (!tf || tf.type !== "reference" || tf.reference?.object !== r.to.object)
        err("rel_through_to", p, `${r.name}: ${j.name}.${r.through.to_field} must be a reference to ${r.to.object}`);
    }
  }

  const seenPaths = new Set<string>();
  for (const [gi, g] of m.data_files.entries()) {
    if (!objects.has(g.object)) err("datafile_object", `/data_files/${gi}`, `data_files refers to unknown object "${g.object}"`);
    for (const f of g.files) {
      if (seenPaths.has(f.path)) err("dup_path", `/data_files/${gi}`, `path listed twice: ${f.path}`);
      seenPaths.add(f.path);
      if (m.conformance.level >= 2 && !f.sha256) err("sha_required", `/data_files/${gi}`, `level ${m.conformance.level} requires sha256 on ${f.path}`);
    }
  }
  for (const o of objects.keys()) if (!m.data_files.some((g) => g.object === o)) warn("no_data", "/data_files", `object "${o}" has no data files`);

  if (m.export.mode === "incremental" && !m.export.parent_bundle_id)
    err("incremental_parent", "/export", "incremental export requires parent_bundle_id");

  return issues;
}

export function parseManifest(text: string, filename = MANIFEST_JSON): unknown {
  return filename.endsWith(".yaml") || filename.endsWith(".yml") ? YAML.parse(text) : JSON.parse(text);
}

/** Read, shape-validate and semantically validate the manifest in a bundle directory. */
export function loadManifest(bundleDir: string): { manifest: Manifest; issues: Issue[] } {
  const jsonPath = join(bundleDir, MANIFEST_JSON);
  const yamlPath = join(bundleDir, MANIFEST_YAML);
  let data: unknown;
  if (existsSync(jsonPath)) data = parseManifest(readFileSync(jsonPath, "utf8"), MANIFEST_JSON);
  else if (existsSync(yamlPath)) data = parseManifest(readFileSync(yamlPath, "utf8"), MANIFEST_YAML);
  else throw new Error(`no ${MANIFEST_JSON} or ${MANIFEST_YAML} in ${bundleDir}`);

  const shape = validateManifestShape(data);
  if (shape.length) return { manifest: data as Manifest, issues: shape };
  return { manifest: data as Manifest, issues: validateManifestSemantics(data as Manifest) };
}

export function manifestToYaml(m: Manifest): string {
  return YAML.stringify(m, { lineWidth: 0 });
}
