import { keywordSearchAllNamespaces } from "../src/search/query";

const root = process.env.HOME + "/duckbrain/namespaces";

async function main() {
  try {
    const r = await keywordSearchAllNamespaces(root, "duckbrain", { limit: 3 });
    console.log(
      "OK total=",
      r.total,
      "searched=",
      r.namespacesSearched.length,
      "skipped=",
      r.namespacesSkipped.length,
    );
  } catch (e: any) {
    console.log("THREW:", e.message);
    console.log((e.stack || "").split("\n").slice(0, 10).join("\n"));
  }
}

main();
