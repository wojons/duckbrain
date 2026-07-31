// Lock-hold simulator for BUG-037 verification.
// Opens namespaces/default/duckdb.db exactly like the live MCP server does
// (exclusive write lock), holds it for 60s, then exits.
const duckdb = require("duckdb");
const path = require("path");

const dbPath = path.join(__dirname, "..", "namespaces", "default", "duckdb.db");
console.log("LOCK-SIM: opening", dbPath);
const db = new duckdb.Database(dbPath);
db.all("SELECT 1", (err) => {
  if (err) {
    console.log("LOCK-SIM: open error:", err.message);
    process.exit(2);
  }
  console.log("LOCK-SIM: lock held on namespaces/default/duckdb.db");
  setTimeout(() => {
    console.log("LOCK-SIM: releasing lock");
    db.close();
    process.exit(0);
  }, 60000);
});
