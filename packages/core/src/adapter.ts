import { BundleWriter, type WriterOptions } from "./bundle.js";
import type { Attachment, Manifest, Schema, Source, UdmpRecord } from "./types.js";

/**
 * Adapter contract (spec §11). Any exporter implements this.
 * Config is adapter-specific (tokens, base URL, filters) and is never written to the bundle.
 */
export interface AdapterContext {
  log: (msg: string) => void;
  /** Store an attachment in the bundle. Adapters call this from read() or afterwards. */
  blob: {
    add: BundleWriter["addBlob"];
    skipped: BundleWriter["skippedBlob"];
    failed: BundleWriter["failedBlob"];
  };
  /** Record something that could not be carried. */
  drop: (entry: UdmpRecord) => void;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Per-file blob size cap in bytes (0 = no cap). */
  maxBlobBytes: number;
}

export interface ReadResult {
  records: AsyncIterable<UdmpRecord>;
  /** Called after iteration completes to obtain the resume cursor. */
  cursor?: () => unknown;
}

export interface BlobRef { url: string; filename?: string; media_type?: string; bytes?: number; [k: string]: unknown }

export interface Adapter<C = Record<string, unknown>> {
  /** Platform slug, e.g. "linear". */
  platform: string;
  displayName: string;
  version: string;
  /** Validate config and return provenance for the manifest `source` block. */
  connect(config: C): Promise<Source>;
  /** Discover the tenant's live schema, including custom fields. */
  discover(config: C, ctx: AdapterContext): Promise<Schema>;
  /** Stream records for one object. Must be resumable from `cursor`. */
  read(config: C, object: string, ctx: AdapterContext, cursor?: unknown): Promise<ReadResult>;
  /** Fetch a binary. Default export runner will call this for BlobRef values it finds. */
  fetchBlob?(config: C, ref: BlobRef, ctx: AdapterContext): Promise<Attachment>;
}

export interface ExportOptions {
  out: string;
  objects?: string[];
  gzip?: boolean;
  since?: string;
  parentBundleId?: string;
  cursor?: Record<string, unknown>;
  maxBlobBytes?: number;
  conformanceLevel?: 1 | 2 | 3;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  writer?: Partial<WriterOptions>;
}

/**
 * Generic export runner: connect → discover → read each object → finalize.
 * Handles chunking, blob storage, cursors and the manifest so adapters only
 * have to speak to their source API.
 */
export async function runExport<C>(adapter: Adapter<C>, config: C, opts: ExportOptions): Promise<Manifest> {
  const log = opts.log ?? (() => {});
  const source = await adapter.connect(config);
  source.adapter ??= { name: `@udmp/adapter-${adapter.platform}`, version: adapter.version };

  let writerRef: BundleWriter | null = null;
  const ctx: AdapterContext = {
    log,
    blob: {
      add: (d, m) => writerRef!.addBlob(d, m),
      skipped: (m, r) => writerRef!.skippedBlob(m, r),
      failed: (m, e) => writerRef!.failedBlob(m, e),
    },
    drop: (e) => writerRef!.drop(e),
    signal: opts.signal,
    maxBlobBytes: opts.maxBlobBytes ?? 100 * 1024 * 1024,
  };

  log(`discovering schema from ${source.platform}${source.instance_id ? " " + source.instance_id : ""}`);
  const full = await adapter.discover(config, ctx);
  const wanted = opts.objects?.length ? new Set(opts.objects) : null;
  const schema: Schema = wanted
    ? {
        objects: full.objects.filter((o) => wanted.has(o.name)),
        relationships: (full.relationships ?? []).filter((r) => wanted.has(r.from.object) && wanted.has(r.to.object) && (!r.through || wanted.has(r.through.object))),
      }
    : full;
  if (wanted) for (const w of wanted) if (!full.objects.some((o) => o.name === w)) throw new Error(`unknown object "${w}" (available: ${full.objects.map((o) => o.name).join(", ")})`);
  log(`schema: ${schema.objects.length} objects, ${schema.relationships?.length ?? 0} relationships`);

  const writer = new BundleWriter({
    dir: opts.out,
    source,
    schema,
    gzip: opts.gzip,
    conformanceLevel: opts.conformanceLevel ?? 3,
    export: {
      mode: opts.since ? "incremental" : "full",
      since: opts.since ?? null,
      until: new Date().toISOString(),
      parent_bundle_id: opts.parentBundleId ?? null,
      objects_requested: opts.objects ?? full.objects.map((o) => o.name),
    },
    ...opts.writer,
  });
  writerRef = writer;

  const cursors: Record<string, unknown> = { ...(opts.cursor ?? {}) };
  for (const obj of schema.objects) {
    if (opts.signal?.aborted) throw new Error("aborted");
    log(`reading ${obj.name}`);
    const res = await adapter.read(config, obj.name, ctx, cursors[obj.name]);
    let n = 0;
    for await (const rec of res.records) {
      await writer.write(obj.name, rec);
      if (++n % 1000 === 0) log(`  ${obj.name}: ${n}`);
    }
    log(`  ${obj.name}: ${n} records`);
    if (res.cursor) cursors[obj.name] = res.cursor();
  }

  const manifest = await writer.finalize({ cursor: cursors });
  log(`wrote bundle ${manifest.bundle_id} to ${opts.out}`);
  return manifest;
}

/** Exponential backoff fetch helper honouring 429/5xx and Retry-After. Adapters should use this. */
export async function fetchWithRetry(input: string | URL, init: RequestInit & { retries?: number; signal?: AbortSignal } = {}): Promise<Response> {
  const retries = init.retries ?? 6;
  let attempt = 0;
  for (;;) {
    const res = await fetch(input, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt++ >= retries) return res;
    const ra = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
    await res.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, wait));
    if (init.signal?.aborted) throw new Error("aborted");
  }
}

/** Standard blob fetcher: GETs a URL and stores it, honouring the size cap. */
export async function fetchBlobToBundle(ctx: AdapterContext, ref: BlobRef, headers: Record<string, string> = {}): Promise<Attachment> {
  const meta = { filename: ref.filename, media_type: ref.media_type, source_url: ref.url };
  if (ctx.maxBlobBytes && ref.bytes && ref.bytes > ctx.maxBlobBytes) return ctx.blob.skipped({ ...meta, bytes: ref.bytes }, `exceeds cap of ${ctx.maxBlobBytes} bytes`);
  try {
    const res = await fetchWithRetry(ref.url, { headers, signal: ctx.signal });
    if (!res.ok || !res.body) return ctx.blob.failed(meta, `HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length"));
    if (ctx.maxBlobBytes && len > ctx.maxBlobBytes) { await res.body.cancel(); return ctx.blob.skipped({ ...meta, bytes: len }, `exceeds cap of ${ctx.maxBlobBytes} bytes`); }
    const mt = ref.media_type ?? res.headers.get("content-type")?.split(";")[0] ?? undefined;
    const { Readable } = await import("node:stream");
    return await ctx.blob.add(Readable.fromWeb(res.body as never), { ...meta, media_type: mt });
  } catch (e) {
    return ctx.blob.failed(meta, (e as Error).message);
  }
}
