import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  validateBundle, BundleReader, importToSqlite, runExport, computeScore,
  type Adapter, type Scorecard,
} from "@udmp/core";

const USAGE = `udmp — Universal Data Migration Protocol

Usage:
  udmp validate <bundle> [--no-checksums] [--json]      Validate a bundle and report its effective conformance level
  udmp inspect  <bundle> [--json]                        Summarise objects, fields, relationships and counts
  udmp export   --adapter <name> --out <dir> [--objects a,b] [--gzip] [--since <iso>] [--config k=v ...]
                                                         Export a SaaS tenant into a bundle
  udmp to-sqlite <bundle> <file.sqlite> [--prefix p]     Load a bundle into a queryable SQLite database
  udmp score    <scorecard.json>                         Compute a SaaS Exit Score from a scorecard
  udmp adapters                                          List adapters installed next to the CLI

Adapter config is read from --config key=value flags and from environment
variables named UDMP_<ADAPTER>_<KEY> (e.g. UDMP_LINEAR_API_KEY). Credentials
never end up in the bundle.
`;

export async function main(argv: string[], io = { out: console.log, err: console.error }): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "validate": return validate(rest, io);
    case "inspect": return inspect(rest, io);
    case "export": return exportCmd(rest, io);
    case "to-sqlite": return toSqlite(rest, io);
    case "score": return score(rest, io);
    case "adapters": return adapters(io);
    case "-h": case "--help": case "help": case undefined: io.out(USAGE); return cmd ? 0 : 1;
    default: io.err(`unknown command "${cmd}"\n`); io.out(USAGE); return 1;
  }
}

type IO = { out: (s: string) => void; err: (s: string) => void };

async function validate(args: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { checksums: { type: "boolean", default: true }, json: { type: "boolean", default: false } } });
  const dir = positionals[0];
  if (!dir) { io.err("validate: bundle directory required"); return 1; }
  const report = await validateBundle(resolve(dir), { checksums: values.checksums, onProgress: values.json ? undefined : (m) => io.err(`  ${m}`) });
  if (values.json) { io.out(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }
  for (const i of report.issues) io.out(`${i.level === "error" ? "ERROR" : "warn "} [${i.code}] ${i.path ? i.path + ": " : ""}${i.message}`);
  const total = Object.values(report.records).reduce((a, b) => a + b, 0);
  io.out(`\n${report.ok ? "OK" : "FAIL"}: ${total} records across ${Object.keys(report.records).length} objects, ${report.checked_files} files, ${report.dangling} dangling references`);
  io.out(`conformance: claimed level ${report.claimed_level}, effective level ${report.effective_level}${report.effective_level >= 3 ? " (Hydrated)" : report.effective_level === 2 ? " (Relational)" : report.effective_level === 1 ? " (Schema)" : " (invalid)"}`);
  return report.ok ? 0 : 1;
}

async function inspect(args: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
  const dir = positionals[0];
  if (!dir) { io.err("inspect: bundle directory required"); return 1; }
  const r = new BundleReader(resolve(dir));
  const m = r.manifest;
  if (values.json) { io.out(JSON.stringify(m, null, 2)); return 0; }
  io.out(`UDMP ${m.udmp_version} bundle ${m.bundle_id}`);
  io.out(`source:   ${m.source.platform_display_name ?? m.source.platform}${m.source.instance_id ? " (" + m.source.instance_id + ")" : ""}${m.source.adapter ? " via " + m.source.adapter.name + "@" + m.source.adapter.version : ""}`);
  io.out(`exported: ${m.exported_at}  mode: ${m.export.mode}  conformance: level ${m.conformance.level}`);
  io.out(`\nobjects (${m.schema.objects.length}):`);
  for (const o of m.schema.objects) {
    const n = m.stats?.records?.[o.name] ?? m.data_files.filter((g) => g.object === o.name).flatMap((g) => g.files).reduce((a, f) => a + f.row_count, 0);
    const custom = o.fields.filter((f) => f.is_custom).length;
    io.out(`  ${o.name.padEnd(24)} ${String(n).padStart(8)} records  ${o.fields.length} fields${custom ? ` (${custom} custom)` : ""}${o.semantic ? "  " + o.semantic : ""}`);
  }
  const rels = m.schema.relationships ?? [];
  io.out(`\nrelationships (${rels.length}):`);
  for (const rel of rels) io.out(`  ${rel.name.padEnd(28)} ${rel.from.object} -[${rel.type}]-> ${rel.to.object}${rel.through ? " via " + rel.through.object : ""}`);
  const blobs = m.blobs?.length ?? 0;
  const bytes = (m.blobs ?? []).reduce((a, b) => a + b.bytes, 0);
  io.out(`\nblobs: ${blobs} files, ${(bytes / 1024 / 1024).toFixed(1)} MB${m.stats ? `  (ok ${m.stats.blobs_ok ?? 0}, skipped ${m.stats.blobs_skipped ?? 0}, failed ${m.stats.blobs_failed ?? 0})` : ""}`);
  if (r.issues.length) { io.out(`\nmanifest issues:`); for (const i of r.issues) io.out(`  ${i.level}: ${i.message}`); }
  return 0;
}

export async function loadAdapter(name: string): Promise<Adapter> {
  const candidates = name.includes("/") || name.startsWith(".") ? [name] : [`@udmp/adapter-${name}`, `udmp-adapter-${name}`, name];
  let lastErr: unknown;
  for (const c of candidates) {
    try {
      const mod = await import(c);
      const a = mod.default ?? mod.adapter;
      if (a && typeof a.discover === "function") return a as Adapter;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`adapter "${name}" not found (tried ${candidates.join(", ")}): ${(lastErr as Error)?.message ?? ""}`);
}

function collectConfig(adapterName: string, flags: string[]): Record<string, string> {
  const cfg: Record<string, string> = {};
  const prefix = `UDMP_${adapterName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith(prefix) && v !== undefined) cfg[k.slice(prefix.length).toLowerCase()] = v;
  for (const f of flags) { const i = f.indexOf("="); if (i < 0) throw new Error(`--config expects key=value, got "${f}"`); cfg[f.slice(0, i)] = f.slice(i + 1); }
  return cfg;
}

async function exportCmd(args: string[], io: IO): Promise<number> {
  const { values } = parseArgs({
    args, allowPositionals: false, options: {
      adapter: { type: "string" }, out: { type: "string" }, objects: { type: "string" }, gzip: { type: "boolean", default: false },
      since: { type: "string" }, parent: { type: "string" }, config: { type: "string", multiple: true, default: [] },
      "max-blob-mb": { type: "string", default: "100" }, quiet: { type: "boolean", default: false },
    },
  });
  if (!values.adapter || !values.out) { io.err("export: --adapter and --out are required"); return 1; }
  const adapter = await loadAdapter(values.adapter);
  const config = collectConfig(adapter.platform, values.config ?? []);
  const ac = new AbortController();
  process.once("SIGINT", () => { io.err("\naborting..."); ac.abort(); });
  const manifest = await runExport(adapter, config, {
    out: resolve(values.out),
    objects: values.objects?.split(",").map((s) => s.trim()).filter(Boolean),
    gzip: values.gzip,
    since: values.since,
    parentBundleId: values.parent,
    maxBlobBytes: Math.round(Number(values["max-blob-mb"]) * 1024 * 1024),
    log: values.quiet ? undefined : (m) => io.err(m),
    signal: ac.signal,
  });
  const total = Object.values(manifest.stats?.records ?? {}).reduce((a, b) => a + b, 0);
  io.out(`exported ${total} records, ${manifest.blobs?.length ?? 0} blobs → ${values.out}`);
  io.out(`next: udmp validate ${values.out}`);
  return 0;
}

async function toSqlite(args: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { prefix: { type: "string", default: "" }, quiet: { type: "boolean", default: false } } });
  const [dir, db] = positionals;
  if (!dir || !db) { io.err("to-sqlite: <bundle> <file.sqlite> required"); return 1; }
  const res = await importToSqlite(resolve(dir), resolve(db), { prefix: values.prefix, onProgress: values.quiet ? undefined : (m) => io.err(`  ${m}`) });
  io.out(`loaded ${res.rows} rows into ${res.tables} tables → ${db}`);
  return 0;
}

async function score(args: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
  const file = positionals[0];
  if (!file) { io.err("score: scorecard.json required"); return 1; }
  const card = JSON.parse(readFileSync(resolve(file), "utf8")) as Scorecard;
  const res = computeScore(card);
  if (values.json) { io.out(JSON.stringify({ platform: card.platform, ...res }, null, 2)); return res.errors.length ? 1 : 0; }
  io.out(`${card.display_name}${card.plan ? " (" + card.plan + ")" : ""}: ${res.total}/100  grade ${res.grade} — ${res.label}`);
  for (const [k, v] of Object.entries(card.criteria)) io.out(`  ${k.padEnd(24)} ${String(v.points).padStart(2)}/20`);
  for (const e of res.errors) io.out(`  ERROR: ${e}`);
  return res.errors.length ? 1 : 0;
}

async function adapters(io: IO): Promise<number> {
  const known = ["linear", "hubspot"];
  for (const k of known) {
    try { const a = await loadAdapter(k); io.out(`${a.platform.padEnd(12)} ${a.displayName} v${a.version}`); }
    catch { io.out(`${k.padEnd(12)} (not installed)`); }
  }
  return 0;
}
