import { existsSync } from "node:fs";
import { BundleReader, safeJoin } from "./bundle.js";
import { sha256File } from "./ndjson.js";
import type { Issue } from "./manifest.js";
import { pkOf, type Field, type ObjectDef, type UdmpRecord } from "./types.js";

export interface ValidationReport {
  ok: boolean;
  claimed_level: number;
  effective_level: number;
  issues: Issue[];
  records: Record<string, number>;
  dangling: number;
  checked_files: number;
}

const RFC3339_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const BLOB = /^sha256-[a-f0-9]{64}$/;

/** Type-check one value against a field definition. Returns an error string or null. */
export function checkValue(f: Pick<Field, "type" | "enum" | "items" | "reference">, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case "string": case "reference": return typeof v === "string" || (f.type === "reference" && Array.isArray(v) && v.every((x) => typeof x === "string")) ? null : "expected string";
    case "integer": return (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^-?\d+$/.test(v)) ? null : "expected integer";
    case "decimal": return typeof v === "string" && DECIMAL.test(v) ? null : "expected decimal string";
    case "float": return typeof v === "number" ? null : "expected number";
    case "boolean": return typeof v === "boolean" ? null : "expected boolean";
    case "date": return typeof v === "string" && DATE.test(v) ? null : "expected YYYY-MM-DD";
    case "datetime": return typeof v === "string" && RFC3339_DT.test(v) ? null : "expected RFC 3339 date-time";
    case "time": return typeof v === "string" && TIME.test(v) ? null : "expected RFC 3339 time";
    case "duration": return typeof v === "string" && DURATION.test(v) ? null : "expected ISO 8601 duration";
    case "currency": return isObj(v) && typeof v.amount === "string" && DECIMAL.test(v.amount) && typeof v.code === "string" ? null : "expected {amount, code}";
    case "enum": {
      if (typeof v !== "string") return "expected string";
      const open = f.enum?.open ?? true;
      return open || f.enum?.values.some((e) => e.value === v) ? null : `value "${v}" not in enum`;
    }
    case "json": return null;
    case "richtext": return isObj(v) && typeof v.markdown === "string" ? null : "expected {markdown, ...}";
    case "attachment": {
      if (!isObj(v)) return "expected attachment object";
      if (!["ok", "skipped", "failed"].includes(String(v.status))) return "attachment.status must be ok|skipped|failed";
      if (v.status === "ok" && !(typeof v.blob === "string" && BLOB.test(v.blob))) return "attachment.blob must be sha256-<hex> when status is ok";
      if (v.status !== "ok" && v.blob !== null && v.blob !== undefined) return "attachment.blob must be null unless status is ok";
      return null;
    }
    case "geo": return isObj(v) && typeof v.lat === "number" && typeof v.lon === "number" ? null : "expected {lat, lon}";
    case "array": {
      if (!Array.isArray(v)) return "expected array";
      if (!f.items) return null;
      for (const x of v) { const e = checkValue({ type: f.items.type, reference: f.items.reference }, x); if (e) return `array item: ${e}`; }
      return null;
    }
  }
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }

export interface ValidateOptions {
  /** Verify sha256 of every data file and blob. Default true. */
  checksums?: boolean;
  /** Stop after this many issues per code to keep reports readable. Default 25. */
  maxIssuesPerCode?: number;
  /** Progress callback. */
  onProgress?: (msg: string) => void;
}

/**
 * Full bundle validation: manifest, every record's types and primary key,
 * referential integrity across the bundle, file checksums, blob presence.
 * Determines the effective conformance level.
 */
export async function validateBundle(dir: string, opts: ValidateOptions = {}): Promise<ValidationReport> {
  const checksums = opts.checksums ?? true;
  const cap = opts.maxIssuesPerCode ?? 25;
  const counts = new Map<string, number>();
  const issues: Issue[] = [];
  const push = (i: Issue) => {
    const n = (counts.get(i.code) ?? 0) + 1; counts.set(i.code, n);
    if (n <= cap) issues.push(i);
    else if (n === cap + 1) issues.push({ ...i, message: `... further "${i.code}" issues suppressed` });
  };
  const log = opts.onProgress ?? (() => {});

  const reader = new BundleReader(dir);
  for (const i of reader.issues) push(i);
  const m = reader.manifest;
  const claimed = m.conformance.level;
  if (reader.issues.some((i) => i.level === "error")) {
    return { ok: false, claimed_level: claimed, effective_level: 0, issues, records: {}, dangling: 0, checked_files: 0 };
  }

  let level2 = true, level3 = true, level1 = true;
  const records: Record<string, number> = {};
  let checkedFiles = 0;

  // Pass 1: per-object type checks, PK presence and uniqueness, collect PK sets; file checksums and row counts.
  const pkSets = new Map<string, Set<string>>();
  const objects = new Map<string, ObjectDef>(m.schema.objects.map((o) => [o.name, o]));
  const blobIds = new Set((m.blobs ?? []).map((b) => b.id));

  for (const g of m.data_files) {
    const obj = objects.get(g.object)!;
    const pks = new Set<string>();
    pkSets.set(obj.name, pks);
    const fieldMap = new Map(obj.fields.map((f) => [f.name, f]));
    let total = 0;
    for (const f of g.files) {
      const abs = safeJoin(dir, f.path);
      if (!existsSync(abs)) { push({ level: "error", code: "file_missing", path: f.path, message: `data file missing: ${f.path}` }); level1 = false; continue; }
      checkedFiles++;
      if (checksums && f.sha256) {
        const { sha256, bytes } = await sha256File(abs);
        if (sha256 !== f.sha256) { push({ level: "error", code: "sha_mismatch", path: f.path, message: `sha256 mismatch for ${f.path}` }); level2 = false; }
        if (f.bytes !== undefined && f.bytes !== bytes) push({ level: "warning", code: "bytes_mismatch", path: f.path, message: `bytes ${bytes} != declared ${f.bytes} for ${f.path}` });
      }
      let rows = 0;
      const { readNdjson } = await import("./ndjson.js");
      for await (const rec of readNdjson(abs, g.compression === "gzip")) {
        rows++; total++;
        const pk = pkOf(obj, rec);
        const pkFields = Array.isArray(obj.primary_key) ? obj.primary_key : [obj.primary_key];
        if (pkFields.some((k) => rec[k] === null || rec[k] === undefined)) { push({ level: "error", code: "pk_null", path: `${f.path}:${rows}`, message: `${obj.name} record ${rows} has null primary key` }); level1 = false; continue; }
        if (pks.has(pk)) { push({ level: "error", code: "pk_dup", path: `${f.path}:${rows}`, message: `${obj.name} duplicate primary key ${pk}` }); level1 = false; }
        pks.add(pk);
        for (const [k, v] of Object.entries(rec)) {
          const fd = fieldMap.get(k);
          if (!fd) { if (!k.startsWith("_")) push({ level: "warning", code: "undeclared_field", path: `${obj.name}.${k}`, message: `undeclared field ${obj.name}.${k}` }); continue; }
          if (v === null && fd.nullable === false) { push({ level: "error", code: "null_violation", path: `${f.path}:${rows}`, message: `${obj.name}.${k} is null but nullable:false` }); level1 = false; continue; }
          const err = checkValue(fd, v);
          if (err) { push({ level: "error", code: "type", path: `${f.path}:${rows}`, message: `${obj.name}.${k} (pk ${pk}): ${err}` }); level1 = false; }
          if (fd.type === "attachment" && isObj(v)) {
            if (v.status === "ok" && typeof v.blob === "string" && !blobIds.has(v.blob) && !reader.blobPath(v.blob)) { push({ level: "error", code: "blob_missing", path: `${f.path}:${rows}`, message: `${obj.name}.${k}: blob ${v.blob} not in bundle` }); level3 = false; }
            if (v.status !== "ok" && !v.source_url) { push({ level: "warning", code: "blob_no_source", path: `${f.path}:${rows}`, message: `${obj.name}.${k}: ${v.status} attachment without source_url` }); level3 = false; }
          }
          if (fd.type === "richtext" && isObj(v) && !v.original) level3 = false;
        }
      }
      if (rows !== f.row_count) { push({ level: "error", code: "row_count", path: f.path, message: `row_count ${f.row_count} != actual ${rows} for ${f.path}` }); level2 = false; }
    }
    records[obj.name] = (records[obj.name] ?? 0) + total;
    log(`checked ${obj.name}: ${total} records`);
  }

  // Pass 2: referential integrity.
  let dangling = 0;
  for (const g of m.data_files) {
    const obj = objects.get(g.object)!;
    const refFields = obj.fields.filter((f) => f.type === "reference" || (f.type === "array" && f.items?.type === "reference"));
    if (!refFields.length) continue;
    const { readNdjson } = await import("./ndjson.js");
    for (const f of g.files) {
      const abs = safeJoin(dir, f.path);
      if (!existsSync(abs)) continue;
      let row = 0;
      for await (const rec of readNdjson(abs, g.compression === "gzip")) {
        row++;
        for (const rf of refFields) {
          const target = rf.type === "reference" ? rf.reference!.object : rf.items!.reference?.object;
          if (!target) continue;
          const v = rec[rf.name];
          if (v === null || v === undefined) continue;
          const set = pkSets.get(target);
          for (const id of Array.isArray(v) ? v : [v]) {
            if (!set || !set.has(String(id))) {
              dangling++; level2 = false;
              push({ level: "error", code: "dangling_ref", path: `${f.path}:${row}`, message: `${obj.name}.${rf.name} -> ${target}:${id} does not exist` });
            }
          }
        }
      }
    }
  }

  // Blobs index vs files on disk.
  for (const b of m.blobs ?? []) {
    const abs = safeJoin(dir, b.path);
    if (!existsSync(abs)) { push({ level: "error", code: "blob_file_missing", path: b.path, message: `blob file missing: ${b.path}` }); level3 = false; continue; }
    if (checksums) {
      const { sha256, bytes } = await sha256File(abs);
      if (sha256 !== b.sha256 || `sha256-${sha256}` !== b.id) { push({ level: "error", code: "blob_sha_mismatch", path: b.path, message: `blob checksum mismatch: ${b.path}` }); level3 = false; }
      if (bytes !== b.bytes) push({ level: "warning", code: "blob_bytes_mismatch", path: b.path, message: `blob bytes ${bytes} != ${b.bytes}` });
    }
  }
  if (claimed >= 2) for (const g of m.data_files) for (const f of g.files) if (!f.sha256) level2 = false;

  const effective = !level1 ? 0 : !level2 ? 1 : !level3 ? 2 : 3;
  if (effective < claimed) push({ level: "error", code: "level_downgrade", path: "/conformance", message: `claimed level ${claimed} but effective level is ${effective}` });
  const ok = !issues.some((i) => i.level === "error");
  return { ok, claimed_level: claimed, effective_level: effective, issues, records, dangling, checked_files: checkedFiles };
}
