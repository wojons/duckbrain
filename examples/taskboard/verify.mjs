#!/usr/bin/env node
/**
 * End-to-end transcript for the task-board demo.
 *
 * It drives the SAME client module the browser uses (public/api.mjs) against a
 * running scratch daemon and prints every request with its status, so the
 * transcript in docs/transcript.txt is reproducible with one command:
 *
 *   node examples/taskboard/verify.mjs
 *
 * Steps: create board → create column → create card → MOVE a card (ordering
 * visible) → filter by assignee → delete a card, then the grant checks
 * (reader reads 200 / writes 403 + the denial in the namespace audit) and the
 * change feed (a move made by a second client arrives on the subscription).
 *
 * Exit code 0 only when every assertion held.
 */
import fs from "fs";
import path from "path";
import { TableClient, DuckBrainError, makeId } from "./public/api.mjs";

const BASE = process.env.DUCKBRAIN_URL ?? "http://127.0.0.1:28777";
const STATE = process.env.TASKBOARD_STATE ?? path.join(process.env.TMPDIR ?? "/tmp", "duckbrain-taskboard");
const NS = process.env.DUCKBRAIN_NAMESPACE ?? "taskboard";
const ADMIN_KEY = process.env.DUCKBRAIN_ADMIN_KEY ?? "tb-admin-demo-key";
const READER_KEY = process.env.DUCKBRAIN_READER_KEY ?? "tb-reader-demo-key";

const admin = new TableClient({ baseUrl: BASE, apiKey: ADMIN_KEY, namespace: NS });
const reader = new TableClient({ baseUrl: BASE, apiKey: READER_KEY, namespace: NS });

let failures = 0;
const ids = {
  board: makeId("board"),
  todo: makeId("col"),
  doing: makeId("col"),
  cardA: makeId("card"),
  cardB: makeId("card"),
  cardC: makeId("card"),
};

function line(text = "") {
  process.stdout.write(`${text}\n`);
}
function step(number, title) {
  line("");
  line(`=== ${number}. ${title} ===`);
}
function show(request, reply) {
  const extra = [];
  if (reply?.durability) extra.push(`X-Durability: ${reply.durability}`);
  line(`  ${request} -> ${reply.status}${extra.length ? ` (${extra.join(", ")})` : ""}`);
}
function check(label, condition, detail = "") {
  if (condition) {
    line(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    line(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const j = (value) => JSON.stringify(value);

async function main() {
  line(`DuckBrain task board — end-to-end transcript`);
  line(`daemon ${BASE}   namespace ${NS}   state ${STATE}`);
  line(`generated ${new Date().toISOString()}`);

  step(1, "the daemon is serving declared tables");
  const health = await admin.health();
  line(`  GET /health -> ${health.status} (${health.body?.status})`);
  const tables = await admin.listTables();
  line(`  GET /api/ns/${NS}/tables -> ${tables.length} declared tables: ${tables.map((t) => t.name).join(", ")}`);
  check("three declared tables", tables.length >= 3, tables.map((t) => t.name).join(","));

  step(2, "create board, columns and cards (POST, one row per card)");
  const boardReply = await admin.insert("boards", {
    id: ids.board,
    name: "Demo board",
    created_at: new Date().toISOString(),
  });
  show(`POST /api/ns/${NS}/tables/boards`, boardReply);
  line(`  body: ${j({ id: ids.board, name: "Demo board" })}`);

  const columnReply = await admin.insert("columns", [
    { id: ids.todo, board_id: ids.board, name: "Todo", position: 1 },
    { id: ids.doing, board_id: ids.board, name: "Doing", position: 2 },
  ]);
  show(`POST /api/ns/${NS}/tables/columns (2 rows)`, columnReply);

  const cardReply = await admin.insert("cards", [
    { id: ids.cardA, board_id: ids.board, column_id: ids.todo, title: "Ship the demo", assignee: "ana", position: 1, created_at: new Date().toISOString() },
    { id: ids.cardB, board_id: ids.board, column_id: ids.todo, title: "Write the README", assignee: "bo", position: 2, created_at: new Date().toISOString() },
    { id: ids.cardC, board_id: ids.board, column_id: ids.doing, title: "Review grants", assignee: "ana", position: 1, created_at: new Date().toISOString() },
  ]);
  show(`POST /api/ns/${NS}/tables/cards (3 rows)`, cardReply);

  step(3, "read the board back exactly as the UI does");
  const todoBefore = await admin.select("cards", {
    filters: { board_id: ids.board, column_id: ids.todo },
    order: "position.asc",
  });
  line(`  GET /api/ns/${NS}/tables/cards?board_id=eq.${ids.board}&column_id=eq.${ids.todo}&order=position.asc -> ${todoBefore.length} rows`);
  for (const card of todoBefore) line(`    ${card.position}. ${card.title} [${card.assignee}]`);
  check("Todo holds 2 cards in order", todoBefore.length === 2 && todoBefore[0].id === ids.cardA);

  step(4, "filter by assignee (server-side, ?assignee=eq.ana)");
  const anaCards = await admin.select("cards", {
    filters: { board_id: ids.board, assignee: "ana" },
    order: "position.asc",
  });
  line(`  GET .../cards?board_id=eq.${ids.board}&assignee=eq.ana -> ${anaCards.length} rows: ${anaCards.map((c) => c.title).join(" | ")}`);
  check("assignee filter returns only ana's cards", anaCards.length === 2 && anaCards.every((c) => c.assignee === "ana"));

  step(5, "MOVE a card between columns (PATCH by primary key, ordering changes)");
  const moveReply = await admin.update("cards", ids.cardA, { column_id: ids.doing, position: 2 });
  show(`PATCH /api/ns/${NS}/tables/cards?pk=eq.${ids.cardA}`, moveReply);
  line(`  body: ${j({ column_id: ids.doing, position: 2 })}`);

  const todoAfter = await admin.select("cards", { filters: { board_id: ids.board, column_id: ids.todo }, order: "position.asc" });
  const doingAfter = await admin.select("cards", { filters: { board_id: ids.board, column_id: ids.doing }, order: "position.asc" });
  line(`  Todo  -> ${todoAfter.map((c) => `${c.position}. ${c.title}`).join(" | ")}`);
  line(`  Doing -> ${doingAfter.map((c) => `${c.position}. ${c.title}`).join(" | ")}`);
  check(
    "cardA left Todo and is second in Doing",
    !todoAfter.some((c) => c.id === ids.cardA) &&
      doingAfter.length === 2 &&
      doingAfter[1].id === ids.cardA,
  );

  step(6, "delete a card (DELETE by primary key)");
  const deleteReply = await admin.remove("cards", ids.cardB);
  show(`DELETE /api/ns/${NS}/tables/cards?pk=eq.${ids.cardB}`, deleteReply);
  const afterDelete = await admin.select("cards", { filters: { board_id: ids.board }, order: "position.asc" });
  line(`  remaining cards: ${afterDelete.map((c) => c.title).join(" | ")}`);
  check("deleted card is gone, the others survive", afterDelete.length === 2 && !afterDelete.some((c) => c.id === ids.cardB));

  step(7, "permissions: the reader token reads the board but cannot write");
  const readerRead = await reader.select("cards", { filters: { board_id: ids.board } });
  line(`  reader GET /api/ns/${NS}/tables/cards -> ${readerRead.length} rows (read grant honored)`);
  check("reader can read", readerRead.length === 2);

  let readerWriteStatus = null;
  let readerWriteMessage = "";
  try {
    await reader.insert("cards", {
      id: makeId("card"),
      board_id: ids.board,
      column_id: ids.todo,
      title: "reader attempt",
      position: 9,
    });
  } catch (error) {
    if (error instanceof DuckBrainError) {
      readerWriteStatus = error.status;
      readerWriteMessage = error.message;
      line(`  reader POST /api/ns/${NS}/tables/cards -> ${error.status} ${error.code}: ${error.message}`);
    } else {
      throw error;
    }
  }
  check("reader write refused with 403 FORBIDDEN", readerWriteStatus === 403, readerWriteMessage);

  let readerDeleteStatus = null;
  try {
    await reader.remove("cards", ids.cardA);
  } catch (error) {
    if (error instanceof DuckBrainError) {
      readerDeleteStatus = error.status;
      line(`  reader DELETE /api/ns/${NS}/tables/cards?pk=eq.${ids.cardA} -> ${error.status} ${error.code}`);
    } else {
      throw error;
    }
  }
  check("reader delete refused with 403", readerDeleteStatus === 403);

  step(8, "the denial is in the namespace audit with reason table_grant");
  const auditFile = path.join(STATE, "namespaces", NS, "_audit", "current.jsonl");
  let denial = null;
  for (let attempt = 0; attempt < 40 && !denial; attempt += 1) {
    if (fs.existsSync(auditFile)) {
      const rows = fs
        .readFileSync(auditFile, "utf-8")
        .split("\n")
        .filter((row) => row.trim() !== "")
        .map((row) => JSON.parse(row));
      denial = [...rows]
        .reverse()
        .find(
          (row) =>
            row.outcome === "denied" &&
            row.principal === "taskboard-reader" &&
            row.reason === "table_grant",
        );
    }
    if (!denial) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (denial) {
    line(`  ${path.relative(process.cwd(), auditFile)}:`);
    line(`  ${j(denial)}`);
  }
  check("audit row recorded with reason table_grant", Boolean(denial));

  step(9, "the change feed delivers a move made by another client");
  const events = [];
  let markReady;
  const connected = new Promise((resolve) => {
    markReady = resolve;
  });
  const subscription = admin.subscribe({
    tables: ["cards"],
    fromNow: true,
    onReady: () => markReady(),
    onEvent: (change) => events.push(change),
    onError: (error) => line(`  feed error: ${error.message}`),
  });
  // Wait for the LIVE stream's ready frame (not the head probe's): a change
  // committed before the subscription registers would otherwise be missed.
  await connected;
  line("  subscribed from the current head; moving cardC from another client…");
  const otherShell = new TableClient({ baseUrl: BASE, apiKey: ADMIN_KEY, namespace: NS });
  await otherShell.update("cards", ids.cardC, { column_id: ids.todo, position: 3 });
  const deadline = Date.now() + 15000;
  while (events.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const event of events) {
    line(`  SSE event: table=${event.table} op=${event.op} key=${j(event.key)} row=${j(event.row)}`);
  }
  check(
    "change event for the moved card arrived without polling",
    events.some((event) => event.op === "update" && event.key?.id === ids.cardC),
  );
  subscription.abort();
  await subscription.done.catch(() => {});

  step(10, "final state read back through the table API");
  const finalRows = await admin.select("cards", { filters: { board_id: ids.board }, order: "position.asc" });
  line(`  GET .../cards?board_id=eq.${ids.board} -> ${finalRows.length} rows`);
  for (const card of finalRows) line(`    ${card.column_id === ids.todo ? "Todo " : "Doing"} ${card.position}. ${card.title} [${card.assignee}]`);

  line("");
  line(failures === 0 ? "RESULT: PASS — every step above was served by DuckBrain." : `RESULT: FAIL — ${failures} assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  line(`ABORTED: ${error?.stack ?? error}`);
  process.exit(1);
});
