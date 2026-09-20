import fs from "fs";
import path from "path";
import duckdb from "duckdb";

const root = process.env.HOME + "/duckbrain/namespaces";

function allAsync(db: any, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => db.all(sql, (e: any, r: any[]) => (e ? reject(e) : resolve(r))));
}

async function main() {
  const nss = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const stale: string[] = [];
  const fresh: string[] = [];
  let noSidecar = 0;

  for (const ns of nss) {
    const sidecar = path.join(root, ns, ".search", "index.duckdb");
    const alt = path.join(root, ns, ".search");
    let file: string | null = null;
    if (fs.existsSync(sidecar)) file = sidecar;
    else if (fs.existsSync(alt)) {
      const cands = fs.readdirSync(alt).filter((f) => f.endsWith(".duckdb"));
      if (cands.length) file = path.join(alt, cands[0]);
    }
    if (!file) {
      noSidecar++;
      continue;
    }
    try {
      const db = new duckdb.Database(file, { access_mode: "READ_ONLY" });
      const info = await allAsync(db, "PRAGMA table_info(memories)");
      const cols = new Set(info.map((r: any) => String(r.name)));
      if (cols.has("valid_from") && cols.has("valid_until")) fresh.push(ns);
      else stale.push(ns + " [" + [...cols].join(",") + "]");
      db.close();
    } catch (e: any) {
      stale.push(ns + " [ERR " + e.message.slice(0, 60) + "]");
    }
  }

  console.log("namespaces with sidecar:", fresh.length + stale.length);
  console.log("  FRESH (has valid_from/valid_until):", fresh.length);
  console.log("  STALE (missing them):", stale.length);
  console.log("  no sidecar:", noSidecar);
  for (const s of stale.slice(0, 12)) console.log("   -", s);
}

main();
