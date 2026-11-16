/**
 * TypeScript types mirroring spec/SPEC.md and schemas/udmp-manifest.schema.json.
 * The JSON Schema is authoritative; these types exist for ergonomics.
 */

export const UDMP_VERSION = "1.0.0";

export type ScalarType =
  | "string" | "integer" | "decimal" | "float" | "boolean"
  | "date" | "datetime" | "time" | "duration"
  | "currency" | "enum" | "reference" | "json" | "richtext" | "attachment" | "geo";

export type FieldType = ScalarType | "array";

export interface EnumValue { value: string; label?: string; order?: number }

export interface Field {
  name: string;
  type: FieldType;
  display_name?: string;
  description?: string;
  nullable?: boolean;
  is_custom?: boolean;
  source_name?: string;
  source_type?: string;
  semantic?: string;
  reference?: { object: string };
  enum?: { values: EnumValue[]; open?: boolean };
  items?: { type: ScalarType; reference?: { object: string } };
  unique?: boolean;
  indexed?: boolean;
}

export interface ObjectDef {
  name: string;
  display_name?: string;
  description?: string;
  semantic?: string;
  source_name?: string;
  primary_key: string | string[];
  fields: Field[];
  ordering?: string[];
  soft_delete_field?: string;
  is_junction?: boolean;
}

export interface Endpoint { object: string; field: string }

export interface Relationship {
  name: string;
  type: "one_to_one" | "one_to_many" | "many_to_many";
  description?: string;
  from: Endpoint;
  to: Endpoint;
  through?: { object: string; from_field: string; to_field: string };
  on_delete?: "set_null" | "cascade" | "restrict";
}

export interface Schema {
  objects: ObjectDef[];
  relationships?: Relationship[];
}

export interface Source {
  platform: string;
  platform_display_name?: string;
  instance_id?: string;
  instance_url?: string;
  region?: string;
  adapter?: { name: string; version: string };
  api_versions?: Record<string, string>;
  [k: string]: unknown;
}

export interface ExportInfo {
  mode: "full" | "incremental";
  since?: string | null;
  until?: string | null;
  parent_bundle_id?: string | null;
  objects_requested?: string[];
  objects_exported?: string[];
  cursor?: Record<string, unknown>;
}

export interface DataFile { path: string; row_count: number; bytes?: number; sha256?: string }

export interface DataFileGroup {
  object: string;
  format: "ndjson";
  compression?: "none" | "gzip";
  files: DataFile[];
}

export interface BlobEntry {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  media_type?: string;
  filename?: string;
}

export interface Stats {
  records?: Record<string, number>;
  dropped?: number;
  blobs_ok?: number;
  blobs_skipped?: number;
  blobs_failed?: number;
  duration_seconds?: number;
}

export interface Manifest {
  udmp_version: string;
  bundle_id: string;
  exported_at: string;
  source: Source;
  export: ExportInfo;
  schema: Schema;
  data_files: DataFileGroup[];
  blobs?: BlobEntry[];
  conformance: { level: 1 | 2 | 3; verified_by?: string; verified_at?: string };
  stats?: Stats;
  extensions?: Record<string, unknown>;
}

/** A record is a plain JSON object. */
export type UdmpRecord = Record<string, unknown>;

export interface RichText {
  markdown: string;
  plain?: string;
  original?: { format: string; content: unknown };
  mentions?: Array<{ object: string; id: string; label?: string }>;
}

export interface Attachment {
  blob: string | null;
  filename?: string;
  media_type?: string;
  bytes?: number;
  source_url?: string;
  fetched_at?: string;
  status: "ok" | "skipped" | "failed";
  error?: string;
}

export interface Currency { amount: string; code: string }
export interface Geo { lat: number; lon: number }

export function primaryKeyFields(obj: ObjectDef): string[] {
  return Array.isArray(obj.primary_key) ? obj.primary_key : [obj.primary_key];
}

/** Stable string form of a record's primary key, for Set/Map membership. */
export function pkOf(obj: ObjectDef, rec: UdmpRecord): string {
  const keys = primaryKeyFields(obj);
  if (keys.length === 1) return String(rec[keys[0]]);
  return JSON.stringify(keys.map((k) => rec[k]));
}
