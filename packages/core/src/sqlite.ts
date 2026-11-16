import { DatabaseSync } from "node:sqlite";
import { BundleReader } from "./bundle.js";
import { primaryKeyFields, type Field, type ObjectDef } from "./types.js";

/**
 * The "Exit Button" importer: turns any UDMP bundle into a queryable SQLite file
 * with real tables, primary keys and foreign keys. Used for local backups and as
 * the reference importer (spec §11.2).
 */
export interface SqliteImportOptions {
  /** Drop and recreate tables if they exist. Default true. */
  replace?: boolean;
  /** Table name prefix, e.g. "hubspot_". Default none. */
  prefix?: string;
  onProgress?: (msg: string) => void;
}

function sqlType(f: Field): string {
  switch (f.type) {
    case "integer": return "INTEGER";
    case "float": return "REAL";
    case "boolean": return "INTEGER";
    case "decimal": case "string": case "date": case "datetime": case "time": case "duration": case "enum": case "reference": return "TEXT";
    default: return "TEXT"; // JSON-encoded
  }
}

function q(id: string): string { return `"${id.replace(/"/g, '""')}"`; }

function toSql(f: Field, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case "boolean": return v ? 1 : 0;
    case "integer": return typeof v === "string" ? v : v; // big ints stay as text strings
    case "reference": return Array.isArray(v) ? JSON.stringify(v) : v;
    case "richtext": return typeof v === "object" && v && "markdown" in v ? (v as { markdown: string }).markdown : JSON.stringify(v);
    case "attachment": return typeof v === "object" && v && "blob" in v ? ((v as { blob: string | null }).blob ?? JSON.stringify(v)) : JSON.stringify(v);
    case "currency": case "geo": case "json": case "array": return JSON.stringify(v);
    default: return v;
  }
}

export function createTableSql(obj: ObjectDef, reader: BundleReader, prefix = ""): string {
  const cols = obj.fields.map((f) => {
    const notNull = f.nullable === false ? " NOT NULL" : "";
    return `  ${q(f.name)} ${sqlType(f)}${notNull}`;
  });
  const pk = primaryKeyFields(obj).map(q).join(", ");
  const fks: string[] = [];
  for (const f of obj.fields) {
    if (f.type === "reference" && f.reference) {
      const target = reader.object(f.reference.object);
      fks.push(`  FOREIGN KEY (${q(f.name)}) REFERENCES ${q(prefix + target.name)}(${primaryKeyFields(target).map(q).join(", ")}) DEFERRABLE INITIALLY DEFERRED`);
    }
  }
  return `CREATE TABLE ${q(prefix + obj.name)} (\n${[...cols, `  PRIMARY KEY (${pk})`, ...fks].join(",\n")}\n);`;
}

export async function importToSqlite(bundleDir: string, dbPath: string, opts: SqliteImportOptions = {}): Promise<{ tables: number; rows: number }> {
  const reader = new BundleReader(bundleDir);
  if (reader.issues.some((i) => i.level === "error")) throw new Error("bundle manifest has errors; run `udmp validate` first");
  const prefix = opts.prefix ?? "";
  const log = opts.onProgress ?? (() => {});
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA foreign_keys = ON;");

  const order = reader.topologicalOrder();
  let rows = 0;
  db.exec("BEGIN;");
  try {
    // Provenance table so a SQLite file is itself traceable.
    db.exec(`CREATE TABLE IF NOT EXISTS ${q("_udmp_bundle")} (bundle_id TEXT PRIMARY KEY, platform TEXT, exported_at TEXT, udmp_version TEXT, manifest TEXT);`);
    db.prepare(`INSERT OR REPLACE INTO ${q("_udmp_bundle")} VALUES (?, ?, ?, ?, ?)`).run(
      reader.manifest.bundle_id, reader.manifest.source.platform, reader.manifest.exported_at, reader.manifest.udmp_version, JSON.stringify(reader.manifest),
    );
    for (const name of order) {
      const obj = reader.object(name);
      if (opts.replace ?? true) db.exec(`DROP TABLE IF EXISTS ${q(prefix + name)};`);
      db.exec(createTableSql(obj, reader, prefix));
    }
    for (const name of order) {
      const obj = reader.object(name);
      const cols = obj.fields.map((f) => f.name);
      const stmt = db.prepare(`INSERT OR REPLACE INTO ${q(prefix + name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
      let n = 0;
      for await (const rec of reader.records(name)) {
        stmt.run(...obj.fields.map((f) => toSql(f, rec[f.name]) as never));
        n++;
      }
      rows += n;
      log(`${prefix + name}: ${n} rows`);
    }
    db.exec("COMMIT;");
  } catch (e) {
    db.exec("ROLLBACK;");
    throw e;
  } finally {
    db.close();
  }
  return { tables: order.length, rows };
}
