// A stand-in for Cloudflare D1 on Node's built-in SQLite, plus a KV and an
// ASSETS stub, so the worker runs in tests exactly as written: same SQL, same
// migration files, same handlers. Only the transport is fake.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params.map((p) => (typeof p === "boolean" ? Number(p) : p)));
  }
  _stmt() {
    return this.db.prepare(this.sql);
  }
  async all() {
    return this._all();
  }
  _all() {
    const rows = this._stmt().all(...this.params).map((r) => ({ ...r }));
    return { results: rows, success: true, meta: {} };
  }
  async first(column) {
    const row = this._stmt().get(...this.params);
    if (!row) return null;
    return column ? row[column] : { ...row };
  }
  async run() {
    return this._run();
  }
  _run() {
    const info = this._stmt().run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export class D1Shim {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async exec(sql) {
    this.db.exec(sql);
  }
  /** Like D1: all statements in one transaction, all or nothing. */
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const out = statements.map((s) => (/^\s*(SELECT|WITH)/i.test(s.sql) || /RETURNING/i.test(s.sql) ? s._all() : s._run()));
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

export class KVShim {
  constructor() {
    this.map = new Map();
  }
  async put(key, value, opts = {}) {
    this.map.set(key, { value: Buffer.from(value), metadata: opts.metadata ?? null });
  }
  async getWithMetadata(key) {
    const hit = this.map.get(key);
    if (!hit) return { value: null, metadata: null };
    return { value: new Blob([hit.value]).stream(), metadata: hit.metadata };
  }
}

/** Serves files from public/ the way Workers static assets does. */
export const assetsShim = {
  async fetch(request) {
    const p = decodeURIComponent(new URL(request.url).pathname);
    const file = path.join(ROOT, "public", p);
    if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(fs.readFileSync(file), { status: 200 });
  },
};

const MIGRATIONS = path.join(ROOT, "migrations");
const migrationFiles = () => fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();

/**
 * A fresh environment with every migration applied, or only those before
 * `before` (a file name prefix such as "0006"), to test a migration's data part.
 */
export async function makeEnv({ before = null } = {}) {
  const DB = new D1Shim();
  for (const name of migrationFiles()) {
    if (before && name >= before) break;
    DB.db.exec(fs.readFileSync(path.join(MIGRATIONS, name), "utf8"));
  }
  return { DB, PHOTOS: new KVShim(), ASSETS: assetsShim, BUILD_ID: "test" };
}

/** Apply the migration files that start with `prefix`, as wrangler would. */
export function applyMigration(env, prefix) {
  for (const name of migrationFiles().filter((n) => n.startsWith(prefix))) {
    env.DB.db.exec(fs.readFileSync(path.join(MIGRATIONS, name), "utf8"));
  }
}
