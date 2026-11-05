/**
 * Task-board UI.
 *
 * The whole application state is derived from DuckBrain on every render: a
 * board switch, a filter change, a card move and an incoming change-feed event
 * all end in the same `render()` which re-reads the three declared tables.
 * There is no client-side model to drift and no browser-side store of any kind.
 */
import { TableClient, makeId, DuckBrainError } from "/api.mjs";

const state = {
  config: null,
  admin: null,
  reader: null,
  actingAs: "admin",
  boardId: null,
  assignee: "",
  events: [],
};

const el = {
  health: document.getElementById("health"),
  actingAs: document.getElementById("acting-as"),
  banner: document.getElementById("banner"),
  boards: document.getElementById("boards"),
  newBoard: document.getElementById("new-board"),
  newBoardName: document.getElementById("new-board-name"),
  filter: document.getElementById("filter"),
  assigneeFilter: document.getElementById("assignee-filter"),
  clearFilter: document.getElementById("clear-filter"),
  columns: document.getElementById("columns"),
  newColumn: document.getElementById("new-column"),
  newColumnName: document.getElementById("new-column-name"),
  events: document.getElementById("events"),
  lastResponse: document.getElementById("last-response"),
};

function client() {
  return state.actingAs === "reader" ? state.reader : state.admin;
}

function showBanner(message, kind = "error") {
  el.banner.hidden = false;
  el.banner.textContent = message;
  el.banner.className = kind === "info" ? "banner info" : "banner";
}

function clearBanner() {
  el.banner.hidden = true;
  el.banner.textContent = "";
}

function describeError(error) {
  if (error instanceof DuckBrainError) {
    const code = error.code ? ` [${error.code}]` : "";
    const durab = error.body?.durability ? "" : "";
    return `${error.status}${code}: ${error.message}${durab}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function guard(action) {
  try {
    const result = await action();
    clearBanner();
    return result;
  } catch (error) {
    showBanner(describeError(error));
    noteResponse(null, error);
    return null;
  }
}

function noteResponse(reply, error) {
  const stamp = new Date().toISOString().slice(11, 19);
  if (error) {
    el.lastResponse.textContent = `${stamp} refused — ${describeError(error)}`;
    return;
  }
  if (!reply) return;
  const bits = [`${stamp} HTTP ${reply.status}`];
  if (reply.durability) bits.push(`X-Durability: ${reply.durability}`);
  if (reply.totalCount !== null && reply.totalCount !== undefined) {
    bits.push(`X-Total-Count: ${reply.totalCount}`);
  }
  el.lastResponse.textContent = bits.join(" · ");
}

async function renderHealth() {
  try {
    const health = await state.admin.health();
    el.health.textContent = `daemon ${health.body?.status ?? health.status}`;
    el.health.className = `pill ${health.status === 200 ? "pill-ok" : "pill-bad"}`;
  } catch (error) {
    el.health.textContent = "daemon unreachable";
    el.health.className = "pill pill-bad";
  }
}

async function renderBoards() {
  const boards = await state.admin.select("boards", { order: "created_at.asc" });
  el.boards.replaceChildren(
    ...boards.map((board) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = board.name;
      button.setAttribute("aria-current", String(board.id === state.boardId));
      button.addEventListener("click", () => {
        state.boardId = board.id;
        render();
      });
      item.append(button);
      return item;
    }),
  );
  if (!state.boardId && boards.length > 0) state.boardId = boards[0].id;
}

async function renderBoard() {
  el.columns.replaceChildren();
  if (!state.boardId) {
    el.columns.innerHTML =
      '<p class="hint">Create a board on the left to start.</p>';
    return;
  }

  const columns = await state.admin.select("columns", {
    filters: { board_id: state.boardId },
    order: "position.asc",
  });

  const filters = { board_id: state.boardId };
  if (state.assignee) filters.assignee = state.assignee;
  const cards = await state.admin.select("cards", {
    filters,
    order: "position.asc",
  });

  for (const column of columns) {
    el.columns.append(renderColumn(column, cards.filter((card) => card.column_id === column.id)));
  }
}

function renderColumn(column, cards) {
  const node = document.createElement("section");
  node.className = "column";
  node.dataset.columnId = column.id;

  const head = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = column.name;
  const count = document.createElement("span");
  count.textContent = `${cards.length} card${cards.length === 1 ? "" : "s"}`;
  head.append(title, count);
  node.append(head);

  for (const card of cards) node.append(renderCard(card));

  const form = document.createElement("form");
  form.className = "inline-form";
  const input = document.createElement("input");
  input.placeholder = "New card";
  input.required = true;
  const assignee = document.createElement("input");
  assignee.placeholder = "assignee";
  assignee.size = 8;
  const add = document.createElement("button");
  add.type = "submit";
  add.textContent = "Add";
  form.append(input, assignee, add);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const position = cards.length === 0 ? 1 : Math.max(...cards.map((card) => Number(card.position) || 0)) + 1;
    const reply = await guard(() =>
      client().insert("cards", {
        id: makeId("card"),
        board_id: state.boardId,
        column_id: column.id,
        title: input.value.trim(),
        assignee: assignee.value.trim() || null,
        position,
        created_at: new Date().toISOString(),
      }),
    );
    if (reply) {
      noteResponse(reply);
      input.value = "";
      assignee.value = "";
      render();
    }
  });

  node.append(form);

  node.addEventListener("dragover", (event) => {
    event.preventDefault();
    node.classList.add("drop-target");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
  node.addEventListener("drop", async (event) => {
    event.preventDefault();
    node.classList.remove("drop-target");
    const cardId = event.dataTransfer?.getData("text/card-id");
    if (!cardId || cardId.startsWith("card-in-column")) return;
    const position = cards.length === 0 ? 1 : Math.max(...cards.map((card) => Number(card.position) || 0)) + 1;
    const reply = await guard(() =>
      client().update("cards", cardId, { column_id: column.id, position }),
    );
    if (reply) {
      noteResponse(reply);
      render();
    }
  });

  return node;
}

function renderCard(card) {
  const node = document.createElement("article");
  node.className = "card";
  node.draggable = true;
  node.dataset.cardId = card.id;
  node.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/card-id", card.id);
    node.classList.add("dragging");
  });
  node.addEventListener("dragend", () => node.classList.remove("dragging"));

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = card.title ?? "(untitled)";

  const meta = document.createElement("div");
  meta.className = "meta";
  const assignee = document.createElement("span");
  assignee.className = "assignee";
  assignee.textContent = card.assignee ?? "";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "Delete";
  remove.addEventListener("click", async () => {
    const reply = await guard(() => client().remove("cards", card.id));
    if (reply) {
      noteResponse(reply);
      render();
    }
  });
  meta.append(assignee, remove);

  node.append(title, meta);
  return node;
}

function renderEvents() {
  el.events.replaceChildren(
    ...state.events.map((entry) => {
      const item = document.createElement("li");
      const table = document.createElement("b");
      table.textContent = entry.table;
      item.append(`${entry.at} `, table, ` ${entry.op} ${entry.key ?? ""}`);
      return item;
    }),
  );
}

async function render() {
  await guard(async () => {
    await renderBoards();
    await renderBoard();
  });
}

async function startFeed() {
  try {
    state.admin.subscribe({
      tables: ["boards", "columns", "cards"],
      fromNow: true,
      onEvent: (change) => {
        state.events.unshift({
          at: new Date().toLocaleTimeString(),
          table: change.table,
          op: change.op,
          key: change.key?.id ?? "",
        });
        state.events = state.events.slice(0, 40);
        renderEvents();
        render();
      },
      onError: (error) => showBanner(`change feed: ${describeError(error)}`),
    });
  } catch (error) {
    showBanner(`change feed: ${describeError(error)}`);
  }
}

async function boot() {
  const config = await fetch("/config.json").then((response) => response.json());
  state.config = config;
  state.admin = new TableClient({
    baseUrl: config.baseUrl,
    apiKey: config.adminKey,
    namespace: config.namespace,
  });
  state.reader = new TableClient({
    baseUrl: config.baseUrl,
    apiKey: config.readerKey,
    namespace: config.namespace,
  });

  el.newBoard.addEventListener("submit", async (event) => {
    event.preventDefault();
    const reply = await guard(() =>
      client().insert("boards", {
        id: makeId("board"),
        name: el.newBoardName.value.trim(),
        created_at: new Date().toISOString(),
      }),
    );
    if (reply) {
      noteResponse(reply);
      el.newBoardName.value = "";
      render();
    }
  });

  el.newColumn.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.boardId) return showBanner("Create a board first.", "info");
    const existing = await client().select("columns", {
      filters: { board_id: state.boardId },
    });
    const position = existing.length === 0 ? 1 : Math.max(...existing.map((column) => Number(column.position) || 0)) + 1;
    const reply = await guard(() =>
      client().insert("columns", {
        id: makeId("col"),
        board_id: state.boardId,
        name: el.newColumnName.value.trim(),
        position,
      }),
    );
    if (reply) {
      noteResponse(reply);
      el.newColumnName.value = "";
      render();
    }
  });

  el.filter.addEventListener("submit", (event) => {
    event.preventDefault();
    state.assignee = el.assigneeFilter.value.trim();
    render();
  });

  el.clearFilter.addEventListener("click", () => {
    state.assignee = "";
    el.assigneeFilter.value = "";
    render();
  });

  el.actingAs.addEventListener("change", () => {
    state.actingAs = el.actingAs.value;
    showBanner(
      state.actingAs === "reader"
        ? "Acting as the reader token: reads work, every write must be refused with 403 table_grant."
        : "Acting as the admin token.",
      "info",
    );
    render();
  });

  await renderHealth();
  await render();
  startFeed();
}

boot().catch((error) => showBanner(describeError(error)));
