/**
 * MCP-CUSTOM-RUNTIME-001 — versioned custom-tool contract + sandboxed
 * execution runtime.
 *
 * Integrators declare their own functions in `duckbrain.config.json`
 * (`customTools` block, see `src/config/index.ts` →
 * `CustomToolsBlockSchema`); this manager validates every declaration,
 * turns each one into a first-class MCP tool (no wrapper sub-tool), and
 * executes calls in isolation:
 *
 * - `javascript` — the module source runs inside `node:vm` with a
 *   realm-empty global (no require/process/fs/network globals, and no
 *   host-realm object injected at all) on a dedicated Worker thread with
 *   a V8 heap limit; wall-clock budget is enforced by
 *   `worker.terminate()`, which cannot be blocked by `while(true)`
 *   because it does not wait for a GC point.
 * - `wasm` — the bytes are instantiated with an EMPTY import namespace
 *   (WasmImportsDenied), so every host import traps at link time; wall
 *   clock + heap limits are enforced the same way as JS.
 *
 * Structured outcomes (never a thrown raw Error across the MCP boundary):
 * every failure class — invalid declaration, missing module, runtime trap,
 * timeout, resource exhaustion, denied capability — resolves to a
 * `CustomToolFailure` payload with a machine-readable `code` so `tools/call`
 * can surface `isError: true` without crashing or hanging the server.
 *
 * Trust boundary: a custom tool's source is USER-SUPPLIED CODE. It runs
 * only when the operator wrote it into the config file (or a file it
 * points at); sandbox escape is assumed attempted, not exceptional. The
 * host keeps no credentials inside the sandbox and no capability is
 * granted implicitly.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TRUST BOUNDARY — read this before adding capabilities or changing the
 * sandbox. The probes that pin it live in custom-runtime.test.ts
 * ("sandbox escape attempts cannot reach host state").
 * ══════════════════════════════════════════════════════════════════════
 *
 * WHAT IS PROTECTED (enforced here, asserted by tests):
 *
 * 1. Resource limits.
 *    - Wall clock: the vm's own `timeout` kills a synchronous infinite loop,
 *      and the parent's `worker.terminate()` at `timeoutMs + 25ms` cannot be
 *      blocked by user code because it does not wait for a GC/safepoint.
 *      Both surface as TIMEOUT; the server stays responsive.
 *    - Memory: `resourceLimits.maxOldGenerationSizeMb` caps the V8 heap of
 *      the whole sandbox thread. Exhaustion surfaces as RESOURCE_EXHAUSTED,
 *      never as an unbounded host allocation.
 * 2. Host capability denial.
 *    - The JS realm is built from a PROTOTYPE-LESS context object whose only
 *      own value is one primitive string (the args JSON). No host-realm
 *      object, function or constructor is injected, so there is no
 *      `x.constructor.constructor` bridge back to the host's `Function`:
 *      `this.constructor.constructor(...)`, `args.constructor.constructor(...)`,
 *      `Object.constructor(...)`, `Function(...)` and `eval(...)` all throw
 *      "Code generation from strings disallowed for this context".
 *    - `codeGeneration.strings: false` is what makes that throw; it applies
 *      to the realm the tool runs in. (Before this guard the classic
 *      `this.constructor.constructor('return process')()` returned the host
 *      `process` — the probe in custom-runtime.test.ts now asserts BLOCKED.)
 *    - `require`, `process`, `fetch`, `Buffer`, module loading and timers do
 *      not exist in the realm. `console` does (Node provides it per vm
 *      context) but writes to the worker's stdout, which the parent drains
 *      to nothing — it can neither reach host state nor pollute the MCP wire.
 *    - WebAssembly is the realm's own intrinsic (`codeGeneration.wasm: true`)
 *      and every module instantiates with an EMPTY import namespace, so no
 *      host function can be linked, in the `wasm` runtime or inside JS.
 *    - Declared capabilities fail closed (CAPABILITY_DECLARED) BEFORE the
 *      module runs: this build grants none, so a declaration is a refusal,
 *      not a bridge.
 * 3. Result hygiene. Only the JSON round trip crosses back; unserializable
 *    results are RESULT_UNSERIALIZABLE, and sandbox stdout/stderr are
 *    drained so a chatty module cannot corrupt the MCP protocol channel.
 *
 * WHAT IS NOT PROTECTED (do not rely on it — this is a known limitation):
 *
 * 1. THERE IS NO OS-LEVEL ISOLATION. The sandbox is a V8 realm on a worker
 *    thread of THIS process: same process, same uid, same filesystem, same
 *    network namespace, same environment. Node documents `node:vm` as NOT a
 *    security mechanism (https://nodejs.org/api/vm.html). There is no
 *    seccomp filter, no container, no chroot and no separate uid: a V8
 *    engine bug, a native addon reachable at process level, or any future
 *    change that injects a single host object into the context would be a
 *    full host compromise. Resource limits bound how LONG and how MUCH a
 *    tool may consume; they are not an isolation boundary.
 * 2. The threat model is therefore OPERATOR-AUTHORED code, not adversarial
 *    code. A tool's source comes from `duckbrain.config.json` (or a file it
 *    points at) and runs with the privileges of the DuckBrain process —
 *    treat the customTools block as executable content, and never point
 *    `module:` at a file an untrusted party can write.
 * 3. Cost. Every call spawns a fresh worker thread; a hostile-but-in-budget
 *    tool can still spend its entire CPU/memory budget on every call.
 * 4. CPU/IO spawned from native code (a wasm module's own compute) is bounded
 *    only by the wall clock and heap ceiling above, not by per-thread quotas.
 *
 * Anything needing a real security boundary must run OUT OF PROCESS under a
 * separate uid / container with seccomp. That is a deployment decision this
 * module cannot make or promise.
 */

import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { z } from "zod";
import type { DuckBrainConfig } from "../config/index";

/* ------------------------------------------------------------------ */
/* Contract                                                           */
/* ------------------------------------------------------------------ */

/** The two sandboxed runtimes a custom tool may target. */
export const CustomRuntimeKindSchema = z.enum(["javascript", "wasm"]);

export type CustomRuntimeKind = z.infer<typeof CustomRuntimeKindSchema>;

/**
 * Explicit host capabilities a tool may request. Everything is denied by
 * default; declaring a capability in the contract is an operator decision
 * recorded in the config file. The current runtime grants NONE of them —
 * a declaration is validated and reported, and `execCustomTool` refuses
 * calls with CAPABILITY_DECLARED until a future runtime implements the
 * capability bridge (fail-closed, never fail-open).
 */
export const CustomCapabilitySchema = z.enum([
  "fs",
  "net",
  "process",
  "env",
  "secret",
]);

export type CustomCapability = z.infer<typeof CustomCapabilitySchema>;

/**
 * JSON Schema 2020-12 subset accepted for a tool's `inputSchema`. It must
 * be a JSON Schema OBJECT; `true`/`false` schema shorthands and non-object
 * forms are refused (a tool without a schema invites unvalidated calls).
 * `additionalProperties`, `items`, `properties` etc. pass through verbatim
 * — the runtime does not interpret the schema's internals, it only checks
 * the argument object against it at call time with `zod`-style loose
 * validation delegated to `validateAgainstJsonSchema` below.
 */
export const JsonSchemaObjectSchema = z
  .object({
    type: z.literal("object").optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.unknown().optional(),
    items: z.unknown().optional(),
    enum: z.array(z.unknown()).optional(),
    description: z.string().optional(),
  })
  .passthrough()
  .refine((v) => v.type === undefined || v.type === "object", {
    message: "inputSchema must describe an object",
  });

/** One versioned custom-tool declaration (`customTools.tools[]`). */
export const CustomToolDefinitionSchema = z.object({
  /** Stable MCP tool name — what agents discover via tools/list. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "must match ^[a-zA-Z][a-zA-Z0-9_-]*$"),
  /** Human/agent-readable description surfaced by tools/list. */
  description: z.string().min(1).max(2048),
  /** Contract version — bump on breaking input/output changes. */
  version: z.string().min(1).max(32),
  /** Which sandboxed runtime executes the module. */
  runtime: CustomRuntimeKindSchema,
  /**
   * Module reference. `javascript`: path to a .js/.mjs/.cjs file, OR
   * `inline:<source>` for an inline script. `wasm`: path to a .wasm file,
   * OR `inline:<base64>` for inline bytes. Relative paths resolve against
   * the duckbrain root (the directory owning duckbrain.config.json).
   */
  module: z.string().min(1),
  /** Host capabilities the tool requests (all denied unless declared —
   *  and declared capabilities still require a runtime that implements
   *  them; see CustomCapabilitySchema). */
  capabilities: z.array(CustomCapabilitySchema).default([]),
  /** JSON Schema (object form) the tool's arguments must satisfy. */
  inputSchema: JsonSchemaObjectSchema.default({ type: "object" }),
});

export type CustomToolDefinition = z.infer<typeof CustomToolDefinitionSchema>;

/** Every failure class `execCustomTool` can return. */
export type CustomToolFailureCode =
  | "TOOL_UNKNOWN"
  | "CONTRACT_INVALID"
  | "MODULE_NOT_FOUND"
  | "MODULE_INVALID"
  | "SCHEMA_INVALID"
  | "RUNTIME_TRAP"
  | "TIMEOUT"
  | "RESOURCE_EXHAUSTED"
  | "CAPABILITY_DENIED"
  | "CAPABILITY_DECLARED"
  | "RESULT_UNSERIALIZABLE";

/**
 * Structured failure payload. `error` makes `wrapHandler` (src/mcp/server.ts)
 * surface `isError: true` while the message stays visible to the agent;
 * `code` follows the SCREAMING_SNAKE convention of the other machine-
 * readable tool failures (BLANK_CONTENT, NAMESPACE_SCOPE, ...).
 */
export interface CustomToolFailure {
  success: false;
  error: string;
  code: CustomToolFailureCode;
  /** Tool name the failure belongs to (omitted for unknown names). */
  tool?: string;
}

/* ------------------------------------------------------------------ */
/* Result contract                                                    */
/* ------------------------------------------------------------------ */

/**
 * The result contract a custom tool's entry point returns. A tool may
 * return the object directly or a Promise resolving to it. Everything
 * must be JSON-serializable — a BigInt, function, circular reference or
 * symbol in the result is RESULT_UNSERIALIZABLE, not a silent `[object
 * Object]` on the wire.
 */
export interface CustomToolResult {
  success: true;
  result: unknown;
}

/** One-shot dispatch message parent -> worker. */
interface ExecRequest {
  kind: CustomRuntimeKind;
  /** Module source (javascript) or base64 bytes (wasm). */
  payload: string;
  argsJson: string;
  inputSchemaJson: string;
  /** Wall-clock budget; the worker self-terminates via Promise.race. */
  timeoutMs: number;
  /** V8 heap ceiling for the execution (JS) / memory guard (wasm). */
  maxHeapMb: number;
}

/** Worker -> parent outcome. Mirrors the structured-failure classes. */
type ExecOutcome =
  | { type: "ok"; result: unknown }
  | { type: "trap"; message: string }
  | { type: "timeout" }
  | { type: "resource"; message: string }
  | { type: "unserializable"; message: string }
  | { type: "schema"; message: string };

/* ------------------------------------------------------------------ */
/* Module reference resolution                                        */
/* ------------------------------------------------------------------ */

/** Max inline JS source / base64 wasm size (256 KB) — a config file is not
 * a code store; bigger modules live on disk. */
const MAX_INLINE_SOURCE_BYTES = 256 * 1024;

function fail(
  code: CustomToolFailureCode,
  error: string,
  tool?: string,
): CustomToolFailure {
  return tool === undefined
    ? { success: false, error, code }
    : { success: false, error, code, tool };
}

/**
 * Resolve a `module` reference to raw payload: JS source text, or wasm
 * bytes (base64). Refuses directory traversal above the duckbrain root —
 * a module must live inside the deployment, not wherever a path happens
 * to lead.
 */
export function resolveCustomModule(
  ref: string,
  runtime: CustomRuntimeKind,
  rootDir: string,
): { payload: string; resolvedPath?: string } | CustomToolFailure {
  const inlinePrefix = "inline:";
  if (ref.startsWith(inlinePrefix)) {
    const inline = ref.slice(inlinePrefix.length);
    if (inline.length === 0) {
      return fail("MODULE_INVALID", "inline module reference is empty");
    }
    if (Buffer.byteLength(inline, "utf-8") > MAX_INLINE_SOURCE_BYTES) {
      return fail(
        "MODULE_INVALID",
        `inline module exceeds ${MAX_INLINE_SOURCE_BYTES} bytes — store it on disk and reference the file`,
      );
    }
    if (runtime === "wasm") {
      // Validate base64 so a typo produces MODULE_INVALID, not a trap later.
      const buf = Buffer.from(inline, "base64");
      if (
        buf.length === 0 ||
        buf.toString("base64").replace(/=+$/, "") !== inline.replace(/=+$/, "")
      ) {
        return fail("MODULE_INVALID", "inline wasm module is not valid base64");
      }
      return { payload: inline };
    }
    return { payload: inline };
  }

  const resolved = path.resolve(rootDir, ref);
  if (!resolved.startsWith(path.resolve(rootDir) + path.sep)) {
    return fail(
      "MODULE_INVALID",
      `module path escapes the duckbrain root: ${ref}`,
    );
  }
  if (!fs.existsSync(resolved)) {
    return fail("MODULE_NOT_FOUND", `module file not found: ${ref}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return fail("MODULE_INVALID", `module is not a regular file: ${ref}`);
  }
  if (stat.size > MAX_INLINE_SOURCE_BYTES) {
    return fail(
      "MODULE_INVALID",
      `module exceeds ${MAX_INLINE_SOURCE_BYTES} bytes: ${ref}`,
    );
  }
  const raw = fs.readFileSync(resolved);
  if (runtime === "wasm") {
    return { payload: raw.toString("base64"), resolvedPath: resolved };
  }
  return { payload: raw.toString("utf-8"), resolvedPath: resolved };
}

/* ------------------------------------------------------------------ */
/* Argument validation against the declared JSON Schema               */
/* ------------------------------------------------------------------ */

/**
 * Minimal JSON-Schema-subset validation of the call arguments:
 * object-ness, required properties, and declared primitive types. Deep
 * keywords (`patternProperties`, `oneOf`, ...) are NOT interpreted — the
 * contract documents this as a floor, integrators needing deeper checks
 * do them inside the tool. Returns the error message, or undefined when
 * the args satisfy the floor.
 */
export function validateArgsAgainstJsonSchema(
  args: unknown,
  schema: unknown,
): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be a JSON object";
  }
  if (schema === null || typeof schema !== "object") return undefined;
  const s = schema as {
    type?: unknown;
    required?: unknown;
    properties?: unknown;
  };
  if (s.type !== undefined && s.type !== "object") {
    return "inputSchema must describe an object";
  }
  if (Array.isArray(s.required)) {
    for (const req of s.required) {
      if (typeof req === "string" && !(req in (args as object))) {
        return `missing required argument: ${req}`;
      }
    }
  }
  if (s.properties !== null && typeof s.properties === "object") {
    const props = s.properties as Record<string, { type?: unknown }>;
    for (const [key, value] of Object.entries(args as object)) {
      const prop = props[key];
      if (prop === undefined) continue;
      const expected = prop.type;
      if (typeof expected !== "string") continue;
      const actual = Array.isArray(value) ? "array" : typeof value;
      const ok =
        expected === "integer"
          ? actual === "number" && Number.isInteger(value)
          : expected === "number"
            ? actual === "number"
            : actual === expected;
      if (!ok) {
        return `argument '${key}' must be of type ${expected}, got ${actual}`;
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Worker bootstrap (runs on the sandbox thread)                      */
/* ------------------------------------------------------------------ */

/**
 * The sandboxed evaluator. Loaded via `eval: true` Worker (no file on
 * disk, nothing for a hostile config to glob). It runs on a thread with a
 * V8 heap limit; JS additionally executes inside `node:vm` so even a
 * speculative `this`-escape cannot reach the worker's own globals — the
 * vm context owns nothing but the argument JSON and WebAssembly.
 *
 * Exposed as a string so the parent can also unit-test its behavior
 * through `new Function`-free direct evaluation if needed.
 */
export const SANDBOX_WORKER_SOURCE = String.raw`
// The whole bootstrap is an IIFE: Node evaluates an eval:true worker source
// as a plain script, where a bare top-level "return" is a SyntaxError. As a
// function body, every guard below can finish(...) then return.
!function () {
const { parentPort, workerData } = require("worker_threads");
const vm = require("vm");
const req = workerData;

function finish(outcome) {
  try {
    parentPort.postMessage(outcome);
  } catch (_) {
    // Serialization failure of the OUTCOME itself — degrade loudly.
    parentPort.postMessage({ type: "unserializable", message: "outcome serialization failed" });
  }
}

try {
  // Schema floor check inside the sandbox too (defense in depth — the
  // parent validates as well; the source ships inside the deployment).
  const schema = JSON.parse(req.inputSchemaJson);
  const args = JSON.parse(req.argsJson);
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    finish({ type: "schema", message: "arguments must be a JSON object" });
    return;
  }
  if (Array.isArray(schema.required)) {
    for (const k of schema.required) {
      if (typeof k === "string" && !(k in args)) {
        finish({ type: "schema", message: "missing required argument: " + k });
        return;
      }
    }
  }

  let exports;
  if (req.kind === "wasm") {
    const bytes = Buffer.from(req.payload, "base64");
    // Empty import namespace: every host import the module declares traps
    // at instantiation — no capability is reachable, declared or not.
    const mod = new WebAssembly.Module(bytes);
    const inst = new WebAssembly.Instance(mod, {});
    const entry = inst.exports;
    const names = Object.keys(entry);
    // Convention: the exported function is the tool entry. When the
    // declared inputSchema requires only numeric properties, they are
    // spread positionally (add(a,b) style); otherwise the entry receives
    // the args object. Exports report arity 0, so the schema — the
    // versioned contract — decides the shape, never fn.length.
    let fn = null;
    for (const n of names) {
      if (typeof entry[n] === "function") { fn = entry[n]; break; }
    }
    if (!fn) {
      finish({ type: "trap", message: "wasm module exports no function to call" });
      return;
    }
    let out;
    try {
      const reqd = Array.isArray(schema.required) ? schema.required : [];
      const numeric =
        reqd.length > 0 &&
        reqd.every((k) => {
          const t = schema.properties && schema.properties[k];
          return t && (t.type === "number" || t.type === "integer");
        });
      if (numeric) {
        out = fn.apply(null, reqd.map((k) => args[k]));
      } else if (reqd.length > 0) {
        out = fn(args);
      } else {
        out = fn();
      }
    } catch (e) {
      finish({ type: "trap", message: "wasm trap: " + (e && e.message ? e.message : String(e)) });
      return;
    }
    exports = out;
  } else {
    // javascript — a REALM-EMPTY host surface. NOTHING from this worker
    // realm is handed to the tool: the context object is prototype-less and
    // carries exactly one primitive string (the args JSON). Injecting the
    // host intrinsics (args, Object, JSON, WebAssembly, ...) was a LIVE
    // escape: this.constructor.constructor('return process')() returned the
    // HOST process, because every host object carries
    // .constructor.constructor === <host Function> and host code generation
    // is not gated by this context's codeGeneration flag.
    //
    // Now:
    //  - the prelude below parses the args INSIDE the realm, so even
    //    args.constructor.constructor is the realm's own Object/Function;
    //  - codeGeneration.strings:false makes the realm's Function()/eval()
    //    throw "Code generation from strings disallowed for this context",
    //    which is exactly what the constructor-escape probe asserts;
    //  - codeGeneration.wasm:true keeps the realm's OWN WebAssembly usable
    //    for self-contained compute; modules still instantiate with an
    //    EMPTY import namespace so no host function can be linked.
    //
    // Absent entirely: require, process, fetch, Buffer, timers, module
    // loading, host state. console exists (Node provides it per vm
    // context) and writes to this worker's stdout, which the parent drains
    // to nothing -- it reaches no host state and never the MCP wire.
    const sandbox = Object.create(null);
    sandbox.__args_json = req.argsJson;
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: true } });
    // The module source is wrapped so a plain "return args;" script is a
    // valid tool: the completion value is the tool's result (or the value
    // assigned to a variable named "tool"). Built with string concatenation
    // only -- this file must stay free of nested template literals so
    // String.raw delivers the source verbatim.
    var PRELUDE = "var args = JSON.parse(__args_json); ";
    var WRAP_OPEN = "(function(){ ";
    var WRAP_TAIL = "\n; return typeof tool !== 'undefined' ? tool : (typeof result !== 'undefined' ? result : undefined); })()";
    let exported;
    try {
      exported = vm.runInContext(
        PRELUDE + WRAP_OPEN + req.payload + WRAP_TAIL,
        context,
        { timeout: req.timeoutMs, displayErrors: true },
      );
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      // The vm's own script timeout fires BEFORE the parent's terminate —
      // a sync infinite loop inside the module lands here. Classify it as
      // the timeout it is, so tools/call reports TIMEOUT, not a generic
      // trap.
      if (msg && msg.indexOf("Script execution timed out") !== -1) {
        finish({ type: "timeout" });
        return;
      }
      finish({ type: "trap", message: "javascript error: " + msg });
      return;
    }
    if (typeof exported === "function") {
      try {
        exports = exported(args);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        finish({ type: "trap", message: "javascript error: " + msg });
        return;
      }
    } else {
      exports = exported;
    }
  }

  // Structural check: the completion value must be JSON-safe. A BigInt,
  // function, symbol or circular reference fails here — never silently
  // mangled on the wire.
  try {
    const probe = JSON.stringify(exports);
    if (probe === undefined) {
      finish({ type: "unserializable", message: "tool returned a non-JSON value (undefined, function, symbol or BigInt)" });
      return;
    }
    finish({ type: "ok", result: JSON.parse(probe) });
  } catch (e) {
    finish({ type: "unserializable", message: "tool result failed JSON serialization: " + (e && e.message ? e.message : String(e)) });
  }
} catch (e) {
  finish({ type: "trap", message: e && e.message ? e.message : String(e) });
}
}();
`;

/* ------------------------------------------------------------------ */
/* Execution                                                          */
/* ------------------------------------------------------------------ */

export interface CustomRuntimeOptions {
  /** Wall-clock budget in ms (default 5000, config-overridable). */
  timeoutMs?: number;
  /** Sandbox thread V8 heap ceiling in MB (default 64). */
  maxHeapMb?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_HEAP_MB = 64;
/** Grace period after terminate() before we stop waiting on the exit event. */
const TERMINATE_GRACE_MS = 2_000;

function failureFromOutcome(
  outcome: ExecOutcome,
  toolName: string,
  timeoutMs: number,
): CustomToolFailure | CustomToolResult {
  switch (outcome.type) {
    case "ok":
      return { success: true, result: outcome.result };
    case "timeout":
      return fail(
        "TIMEOUT",
        `custom tool '${toolName}' exceeded its ${timeoutMs}ms execution budget`,
        toolName,
      );
    case "resource":
      return fail(
        "RESOURCE_EXHAUSTED",
        `custom tool '${toolName}' exceeded its memory budget: ${outcome.message}`,
        toolName,
      );
    case "trap":
      return fail(
        "RUNTIME_TRAP",
        `custom tool '${toolName}' failed: ${outcome.message}`,
        toolName,
      );
    case "schema":
      return fail("SCHEMA_INVALID", outcome.message, toolName);
    case "unserializable":
      return fail("RESULT_UNSERIALIZABLE", outcome.message, toolName);
  }
}

/**
 * Execute one custom-tool call on a fresh sandbox Worker thread.
 *
 * Fresh-per-call (no pooling): a terminated worker must never be reused,
 * and per-call isolation means a tool that poisons its realm cannot affect
 * the next call of ANY tool. Cost is one thread spawn per call — bounded
 * by the same wall clock the tool gets.
 */
export async function executeInSandbox(
  def: CustomToolDefinition,
  payload: string,
  args: unknown,
  options: CustomRuntimeOptions = {},
): Promise<CustomToolResult | CustomToolFailure> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxHeapMb = options.maxHeapMb ?? DEFAULT_MAX_HEAP_MB;

  const request: ExecRequest = {
    kind: def.runtime,
    payload,
    argsJson: JSON.stringify(args ?? {}),
    inputSchemaJson: JSON.stringify(def.inputSchema),
    timeoutMs,
    maxHeapMb,
  };

  let worker: Worker;
  let parentTerminated = false;
  try {
    worker = new Worker(SANDBOX_WORKER_SOURCE, {
      eval: true,
      workerData: request,
      resourceLimits: {
        maxOldGenerationSizeMb: maxHeapMb,
        maxYoungGenerationSizeMb: Math.min(16, Math.ceil(maxHeapMb / 4)),
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
      stdout: true,
      stderr: true,
    });
  } catch (e) {
    return fail(
      "RESOURCE_EXHAUSTED",
      `could not start sandbox worker: ${e instanceof Error ? e.message : String(e)}`,
      def.name,
    );
  }

  // Sandbox stdout/stderr are NEVER the parent's stdout (MCP protocol
  // channel) — drain to nothing so a chatty module cannot corrupt the
  // wire or flood the server log.
  worker.stdout.resume();
  worker.stderr.resume();

  const done = new Promise<ExecOutcome>((resolve) => {
    worker.once("message", (m: ExecOutcome) => resolve(m));
    // An `error` event means the worker thread died hard — a V8 heap OOM
    // inside resourceLimits surfaces here (RangeError: Array buffer
    // allocation exceeded), not as a message. Classify it as the resource
    // exhaustion it is.
    worker.once("error", (e: Error) => {
      const msg = e.message ?? String(e);
      if (
        msg.includes("Array buffer allocation") ||
        msg.includes("heap") ||
        msg.includes("out of memory")
      ) {
        resolve({ type: "resource", message: msg });
      } else {
        resolve({ type: "trap", message: msg });
      }
    });
    worker.once("exit", (code: number) => {
      // Exit without a message: either the parent's terminate() landed
      // first (a budget kill — the vm's own script timeout races it) or a
      // genuine crash (bootstrap OOM). Only the latter is resource
      // exhaustion; a terminate we ordered IS the timeout contract.
      setTimeout(
        () =>
          resolve(
            parentTerminated
              ? { type: "timeout" }
              : {
                  type: "resource",
                  message: `sandbox exited without a result (code ${code})`,
                },
          ),
        0,
      );
    });
  });

  const timer = setTimeout(() => {
    // terminate() is not cancellable by user code — this is the hard
    // guarantee behind the TIMEOUT contract.
    parentTerminated = true;
    void worker.terminate();
  }, timeoutMs + 25); // small slack so self-raced tools can finish cleanly

  try {
    const outcome = await Promise.race([
      done,
      new Promise<ExecOutcome>((resolve) =>
        // Backstop: if neither message nor exit ever arrives (broken
        // worker), the parent still resolves.
        setTimeout(
          () => resolve({ type: "timeout" }),
          timeoutMs + TERMINATE_GRACE_MS,
        ),
      ),
    ]);
    return failureFromOutcome(outcome, def.name, timeoutMs);
  } finally {
    clearTimeout(timer);
    if (worker.threadId !== -1) {
      // Idempotent; guarantees no orphaned sandbox threads accumulate.
      void worker.terminate().catch(() => undefined);
    }
  }
}

/**
 * Convert the DECLARED JSON Schema object into a zod raw shape the MCP SDK
 * accepts, so tools/list shows the integrator's schema (the SDK converts it
 * back to JSON Schema on the wire) and the transport rejects malformed
 * argument objects before the handler runs.
 *
 * Supported property types are the primitives the sandbox can hand to a
 * tool: string, number, integer, boolean, array, object. Unknown/complex
 * keywords are not modeled — the runtime's floor validation still runs at
 * execution time, and anyProperty-style escape hatches keep working via
 * `additionalProperties`.
 */
export function jsonSchemaToZodShape(
  schema: unknown,
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (schema === null || typeof schema !== "object") return shape;
  const s = schema as {
    properties?: Record<string, { type?: unknown; description?: unknown }>;
    required?: unknown;
  };
  const required = new Set<string>(
    Array.isArray(s.required)
      ? s.required.filter((v): v is string => typeof v === "string")
      : [],
  );
  const one = (type: unknown, description: unknown): z.ZodTypeAny => {
    let base: z.ZodTypeAny;
    switch (type) {
      case "string":
        base = z.string();
        break;
      case "number":
        base = z.number();
        break;
      case "integer":
        base = z.number().int();
        break;
      case "boolean":
        base = z.boolean();
        break;
      case "array":
        base = z.array(z.unknown());
        break;
      case "object":
        base = z.record(z.string(), z.unknown());
        break;
      default:
        base = z.unknown();
    }
    return typeof description === "string" ? base.describe(description) : base;
  };
  if (s.properties && typeof s.properties === "object") {
    for (const [key, prop] of Object.entries(s.properties)) {
      const propSchema = prop !== null && typeof prop === "object" ? prop : {};
      const field = one(propSchema.type, propSchema.description);
      shape[key] = required.has(key) ? field : field.optional();
    }
  }
  return shape;
}

/* ------------------------------------------------------------------ */
/* Manager: registration + execution                                 */
/* ------------------------------------------------------------------ */

/** A validated custom tool ready for MCP registration. */
export interface RegisteredCustomTool {
  def: CustomToolDefinition;
  /** Raw payload (JS source or base64 wasm) resolved at registration. */
  payload: string;
}

/**
 * Discover + validate every custom-tool declaration in the config.
 *
 * Never throws: a bad block degrades to `invalid` entries the manager
 * reports (and refuses to register) while healthy tools still load —
 * one broken declaration must not take the whole custom-tool surface
 * down.
 */
export class CustomRuntimeManager {
  private tools = new Map<string, RegisteredCustomTool>();
  private invalid: Array<{ index: number; reason: string }> = [];
  private runtimeOptions: CustomRuntimeOptions;

  constructor(
    config: DuckBrainConfig,
    private readonly rootDir: string,
    runtimeOptions: CustomRuntimeOptions = {},
  ) {
    // Config budgets are the defaults; explicit options (tests/embedders)
    // win so a suite can shrink the wall clock without touching config.
    this.runtimeOptions = {
      timeoutMs: config.customTools?.timeoutMs,
      maxHeapMb: config.customTools?.maxHeapMb,
      ...runtimeOptions,
    };
    this.loadFromConfig(config);
  }

  private loadFromConfig(config: DuckBrainConfig): void {
    this.tools.clear();
    this.invalid = [];
    const block = config.customTools;
    if (!block || !block.enabled || !Array.isArray(block.tools)) return;

    block.tools.forEach((raw, index) => {
      const parsed = CustomToolDefinitionSchema.safeParse(raw);
      if (!parsed.success) {
        this.invalid.push({
          index,
          reason: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
        return;
      }
      const def = parsed.data;
      // Reserved prefixes: custom tools must never shadow the built-ins or
      // each other — duplicates are reported, not silently overwritten.
      if (this.tools.has(def.name)) {
        this.invalid.push({
          index,
          reason: `duplicate tool name '${def.name}'`,
        });
        return;
      }
      const resolved = resolveCustomModule(
        def.module,
        def.runtime,
        this.rootDir,
      );
      if ("code" in resolved && resolved.code !== undefined) {
        this.invalid.push({ index, reason: resolved.error });
        return;
      }
      this.tools.set(def.name, {
        def,
        payload: (resolved as { payload: string }).payload,
      });
    });
  }

  /** Validated tools, ready for `registerCustomTools` to wire into MCP. */
  listTools(): CustomToolDefinition[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  /** Declarations that failed validation, for startup diagnostics. */
  listInvalid(): Array<{ index: number; reason: string }> {
    return [...this.invalid];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredCustomTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Execute a custom tool by name through the sandbox.
   *
   * Order of checks is the security order: unknown tool -> contract
   * validation -> module availability -> DECLARED capabilities -> args.
   * Capability declarations fail closed (CAPABILITY_DECLARED) because the
   * current runtime implements no capability bridge; the check happens
   * BEFORE execution so a tool never runs with a promise the host cannot
   * keep.
   */
  async exec(
    name: string,
    args: unknown,
  ): Promise<CustomToolResult | CustomToolFailure> {
    const registered = this.tools.get(name);
    if (!registered) {
      return fail("TOOL_UNKNOWN", `unknown custom tool: ${name}`);
    }
    const def = registered.def;

    if (def.capabilities.length > 0) {
      return fail(
        "CAPABILITY_DECLARED",
        `custom tool '${name}' declares host capabilities [${def.capabilities.join(", ")}] but this DuckBrain build grants none — remove the capability declaration or run the tool outside the sandbox`,
        name,
      );
    }

    const schemaError = validateArgsAgainstJsonSchema(args, def.inputSchema);
    if (schemaError !== undefined) {
      return fail(
        "SCHEMA_INVALID",
        `invalid arguments for '${name}': ${schemaError}`,
        name,
      );
    }

    return executeInSandbox(def, registered.payload, args, this.runtimeOptions);
  }

  /** Test/embedder seam: swap the runtime options (budgets). */
  setRuntimeOptions(options: CustomRuntimeOptions): void {
    this.runtimeOptions = options;
  }
}
