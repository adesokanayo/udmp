import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { createGunzip, createGzip, type Gzip } from "node:zlib";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { UdmpRecord } from "./types.js";

/** Stream records from an NDJSON file, optionally gzip-compressed, with bounded memory. */
export async function* readNdjson(path: string, gzip = path.endsWith(".gz")): AsyncGenerator<UdmpRecord> {
  const raw = createReadStream(path);
  const input = gzip ? raw.pipe(createGunzip()) : raw;
  const rl = createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line);
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("record is not a JSON object");
      yield v as UdmpRecord;
    } catch (e) {
      throw new Error(`${path}:${lineNo}: ${(e as Error).message}`);
    }
  }
}

/**
 * Writes NDJSON lines to a file while tracking row count, byte size and SHA-256
 * of the bytes as stored (compressed if gzip).
 */
export class NdjsonWriter {
  readonly path: string;
  rows = 0;
  bytes = 0;
  private hash = createHash("sha256");
  private file: WriteStream;
  private sink: Gzip | WriteStream;
  private closed = false;

  constructor(path: string, readonly gzip: boolean) {
    this.path = path;
    this.file = createWriteStream(path);
    this.file.on("error", () => {});
    if (gzip) {
      const gz = createGzip();
      gz.on("data", (c: Buffer) => { this.hash.update(c); this.bytes += c.length; });
      gz.pipe(this.file);
      this.sink = gz;
    } else {
      this.sink = this.file;
    }
  }

  async write(rec: UdmpRecord): Promise<void> {
    const line = JSON.stringify(rec) + "\n";
    const buf = Buffer.from(line, "utf8");
    if (!this.gzip) { this.hash.update(buf); this.bytes += buf.length; }
    this.rows++;
    if (!this.sink.write(buf)) await once(this.sink, "drain");
  }

  async close(): Promise<{ rows: number; bytes: number; sha256: string }> {
    if (!this.closed) {
      this.closed = true;
      this.sink.end();
      await once(this.file, "finish");
    }
    return { rows: this.rows, bytes: this.bytes, sha256: this.hash.digest("hex") };
  }
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { h.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: h.digest("hex"), bytes };
}
