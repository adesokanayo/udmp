import { mkdirSync, existsSync, writeFileSync, readdirSync, statSync, renameSync, createWriteStream } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { readNdjson, NdjsonWriter } from "./ndjson.js";
import { loadManifest, manifestToYaml, MANIFEST_JSON, MANIFEST_YAML, type Issue } from "./manifest.js";
import {
  UDMP_VERSION, type Manifest, type ObjectDef, type Relationship, type Schema, type Source, type UdmpRecord,
  type DataFileGroup, type BlobEntry, type Attachment, type ExportInfo, type Stats,
} from "./types.js";

/** Reject manifest paths that escape the bundle. */
export function safeJoin(root: string, rel: string): string {
  if (rel.startsWith("/") || rel.split("/").includes("..")) throw new Error(`unsafe path in manifest: ${rel}`);
  const abs = resolve(root, rel);
  if (!abs.startsWith(resolve(root) + sep) && abs !== resolve(root)) throw new Error(`path escapes bundle: ${rel}`);
  return abs;
}

/** Read side of a bundle. */
export class BundleReader {
  readonly manifest: Manifest;
  readonly issues: Issue[];
  private objects: Map<string, ObjectDef>;

  constructor(readonly dir: string) {
    const { manifest, issues } = loadManifest(dir);
    this.manifest = manifest;
    this.issues = issues;
    this.objects = new Map(manifest.schema.objects.map((o) => [o.name, o]));
  }

  object(name: string): ObjectDef {
    const o = this.objects.get(name);
    if (!o) throw new Error(`unknown object "${name}"`);
    return o;
  }

  objectNames(): string[] { return [...this.objects.keys()]; }

  dataFiles(object: string): DataFileGroup[] { return this.manifest.data_files.filter((g) => g.object === object); }

  /** Stream every record of an object across all its chunks, in manifest order. */
  async *records(object: string): AsyncGenerator<UdmpRecord> {
    for (const g of this.dataFiles(object)) {
      const gz = g.compression === "gzip";
      for (const f of g.files) yield* readNdjson(safeJoin(this.dir, f.path), gz);
    }
  }

  /** Locate a blob file by content address, honouring the optional extension. */
  blobPath(blobId: string): string | null {
    const entry = this.manifest.blobs?.find((b) => b.id === blobId);
    if (entry) return safeJoin(this.dir, entry.path);
    const blobsDir = join(this.dir, "blobs");
    if (!existsSync(blobsDir)) return null;
    const hit = readdirSync(blobsDir).find((f) => f === blobId || f.startsWith(blobId + "."));
    return hit ? join(blobsDir, hit) : null;
  }

  /** Objects sorted so referenced objects come before referencing ones; junctions last. */
  topologicalOrder(): string[] {
    const rels = this.manifest.schema.relationships ?? [];
    const deps = new Map<string, Set<string>>();
    for (const o of this.objects.keys()) deps.set(o, new Set());
    for (const o of this.objects.values())
      for (const f of o.fields) {
        const target = f.type === "reference" ? f.reference?.object : f.type === "array" ? f.items?.reference?.object : undefined;
        if (target && target !== o.name && deps.has(target)) deps.get(o.name)!.add(target);
      }
    for (const r of rels) if (r.type !== "many_to_many" && r.from.object !== r.to.object) deps.get(r.to.object)?.add(r.from.object);
    const out: string[] = [];
    const state = new Map<string, 0 | 1 | 2>();
    const visit = (n: string) => {
      const s = state.get(n) ?? 0;
      if (s === 2) return;
      if (s === 1) return; // cycle: self or mutual references, emit in encounter order
      state.set(n, 1);
      for (const d of deps.get(n) ?? []) visit(d);
      state.set(n, 2);
      out.push(n);
    };
    const junctions = new Set(rels.filter((r) => r.through).map((r) => r.through!.object));
    for (const o of this.objects.keys()) if (!junctions.has(o)) visit(o);
    for (const o of junctions) visit(o);
    return out;
  }
}

export interface WriterOptions {
  dir: string;
  source: Source;
  schema: Schema;
  export?: Partial<ExportInfo>;
  gzip?: boolean;
  maxRowsPerChunk?: number;
  maxBytesPerChunk?: number;
  conformanceLevel?: 1 | 2 | 3;
  bundleId?: string;
  exportedAt?: string;
  writeYaml?: boolean;
}

interface OpenChunk { writer: NdjsonWriter; rel: string }

/** Write side of a bundle. Streams records into chunked NDJSON and builds the manifest. */
export class BundleWriter {
  readonly dir: string;
  readonly bundleId: string;
  readonly exportedAt: string;
  private opts: Required<Pick<WriterOptions, "gzip" | "maxRowsPerChunk" | "maxBytesPerChunk" | "conformanceLevel" | "writeYaml">> & WriterOptions;
  private groups = new Map<string, DataFileGroup>();
  private chunkNo = new Map<string, number>();
  private open = new Map<string, OpenChunk>();
  private blobs = new Map<string, BlobEntry>();
  private objectDefs: Map<string, ObjectDef>;
  private counts = new Map<string, number>();
  private dropped: UdmpRecord[] = [];
  private blobStats = { ok: 0, skipped: 0, failed: 0 };
  private startedAt = Date.now();
  private finalized = false;

  constructor(options: WriterOptions) {
    this.opts = {
      gzip: false, maxRowsPerChunk: 100_000, maxBytesPerChunk: 50 * 1024 * 1024, conformanceLevel: 2, writeYaml: true,
      ...options,
    };
    this.dir = options.dir;
    this.bundleId = options.bundleId ?? randomUUID();
    this.exportedAt = options.exportedAt ?? new Date().toISOString();
    this.objectDefs = new Map(options.schema.objects.map((o) => [o.name, o]));
    mkdirSync(join(this.dir, "data"), { recursive: true });
    mkdirSync(join(this.dir, "blobs"), { recursive: true });
    mkdirSync(join(this.dir, "meta"), { recursive: true });
  }

  private async rotate(object: string): Promise<OpenChunk> {
    const cur = this.open.get(object);
    if (cur) await this.closeChunk(object, cur);
    const n = (this.chunkNo.get(object) ?? 0) + 1;
    this.chunkNo.set(object, n);
    mkdirSync(join(this.dir, "data", object), { recursive: true });
    const rel = `data/${object}/${String(n).padStart(5, "0")}.ndjson${this.opts.gzip ? ".gz" : ""}`;
    const chunk = { writer: new NdjsonWriter(join(this.dir, rel), this.opts.gzip), rel };
    this.open.set(object, chunk);
    return chunk;
  }

  private async closeChunk(object: string, c: OpenChunk) {
    const { rows, bytes, sha256 } = await c.writer.close();
    let g = this.groups.get(object);
    if (!g) { g = { object, format: "ndjson", compression: this.opts.gzip ? "gzip" : "none", files: [] }; this.groups.set(object, g); }
    g.files.push({ path: c.rel, row_count: rows, bytes, sha256 });
    this.open.delete(object);
  }

  async write(object: string, rec: UdmpRecord): Promise<void> {
    if (!this.objectDefs.has(object)) throw new Error(`write: unknown object "${object}"`);
    let c = this.open.get(object);
    if (!c || c.writer.rows >= this.opts.maxRowsPerChunk || c.writer.bytes >= this.opts.maxBytesPerChunk) c = await this.rotate(object);
    await c.writer.write(rec);
    this.counts.set(object, (this.counts.get(object) ?? 0) + 1);
  }

  /** Record a dropped record or field for meta/dropped.ndjson. */
  drop(entry: UdmpRecord): void { this.dropped.push(entry); }

  /**
   * Store bytes as a content-addressed blob. Returns an Attachment value for the record.
   * Accepts a Buffer or a readable stream; streams are hashed to a temp file then renamed.
   */
  async addBlob(
    data: Buffer | Readable | AsyncIterable<Uint8Array>,
    meta: { filename?: string; media_type?: string; source_url?: string }
  ): Promise<Attachment> {
    const ext = meta.filename ? extname(meta.filename).toLowerCase().replace(/[^.a-z0-9]/g, "") : "";
    const tmp = join(this.dir, "blobs", `.tmp-${randomUUID()}`);
    const hash = createHash("sha256");
    let bytes = 0;
    if (Buffer.isBuffer(data)) {
      hash.update(data); bytes = data.length; writeFileSync(tmp, data);
    } else {
      const src = data instanceof Readable ? data : Readable.from(data);
      const counter = new (await import("node:stream")).Transform({
        transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); },
      });
      await pipeline(src, counter, createWriteStream(tmp));
    }
    const sha = hash.digest("hex");
    const id = `sha256-${sha}`;
    const rel = `blobs/${id}${ext}`;
    const final = join(this.dir, rel);
    if (existsSync(final)) { (await import("node:fs/promises")).rm(tmp); } else renameSync(tmp, final);
    if (!this.blobs.has(id)) this.blobs.set(id, { id, path: rel, bytes, sha256: sha, media_type: meta.media_type, filename: meta.filename });
    this.blobStats.ok++;
    return { blob: id, filename: meta.filename, media_type: meta.media_type, bytes, source_url: stripQuery(meta.source_url), fetched_at: new Date().toISOString(), status: "ok" };
  }

  skippedBlob(meta: { filename?: string; media_type?: string; source_url?: string; bytes?: number }, reason: string): Attachment {
    this.blobStats.skipped++;
    return { blob: null, ...meta, status: "skipped", error: reason };
  }

  failedBlob(meta: { filename?: string; media_type?: string; source_url?: string }, error: string): Attachment {
    this.blobStats.failed++;
    return { blob: null, ...meta, status: "failed", error };
  }

  async finalize(extra: { stats?: Partial<Stats>; extensions?: Record<string, unknown>; cursor?: Record<string, unknown> } = {}): Promise<Manifest> {
    if (this.finalized) throw new Error("finalize called twice");
    this.finalized = true;
    for (const [o, c] of [...this.open.entries()]) await this.closeChunk(o, c);
    // Objects with zero records still get an (empty) group so validators do not warn.
    for (const o of this.objectDefs.keys()) if (!this.groups.has(o)) this.groups.set(o, { object: o, format: "ndjson", compression: this.opts.gzip ? "gzip" : "none", files: [] });

    if (this.dropped.length) {
      const w = new NdjsonWriter(join(this.dir, "meta", "dropped.ndjson"), false);
      for (const d of this.dropped) await w.write(d);
      await w.close();
    }

    const manifest: Manifest = {
      udmp_version: UDMP_VERSION,
      bundle_id: this.bundleId,
      exported_at: this.exportedAt,
      source: this.opts.source,
      export: { mode: "full", objects_exported: [...this.objectDefs.keys()], ...this.opts.export, ...(extra.cursor ? { cursor: extra.cursor } : {}) },
      schema: { objects: this.opts.schema.objects, relationships: this.opts.schema.relationships ?? [] },
      data_files: [...this.groups.values()],
      blobs: [...this.blobs.values()],
      conformance: { level: this.opts.conformanceLevel },
      stats: {
        records: Object.fromEntries(this.counts),
        dropped: this.dropped.length,
        blobs_ok: this.blobStats.ok, blobs_skipped: this.blobStats.skipped, blobs_failed: this.blobStats.failed,
        duration_seconds: Math.round((Date.now() - this.startedAt) / 100) / 10,
        ...extra.stats,
      },
      ...(extra.extensions ? { extensions: extra.extensions } : {}),
    };
    writeFileSync(join(this.dir, MANIFEST_JSON), JSON.stringify(manifest, null, 2) + "\n");
    if (this.opts.writeYaml) writeFileSync(join(this.dir, MANIFEST_YAML), manifestToYaml(manifest));
    return manifest;
  }
}

export function stripQuery(url?: string): string | undefined {
  if (!url) return undefined;
  try { const u = new URL(url); u.search = ""; return u.toString(); } catch { return url; }
}

/** Convenience for small in-memory exports and tests. */
export async function writeBundle(
  options: WriterOptions,
  data: Record<string, UdmpRecord[]>,
): Promise<Manifest> {
  const w = new BundleWriter(options);
  for (const [obj, recs] of Object.entries(data)) for (const r of recs) await w.write(obj, r);
  return w.finalize();
}

export function bundleSizeOnDisk(dir: string): number {
  let total = 0;
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else total += statSync(p).size; } };
  walk(dir);
  return total;
}

export type { Relationship };
