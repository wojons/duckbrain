#!/usr/bin/env node
/**
 * DuckBrain CLI Executable
 *
 * Main CLI entry point that routes commands to appropriate handlers.
 *
 * Usage:
 *   duckbrain <command> [options]
 *
 * Commands:
 *   stdio       Start MCP server for local Claude (stdio mode)
 *   http        Start MCP server with HTTP transport
 *   service     Manage systemd service (install/start/stop/restart/status)
 *   remember    Remember a memory (human operator)
 *   recall      Query memories (human operator)
 *   list-keys   List memory keys (human operator)
 *   forget      Delete a memory (human operator)
 *   config      Show or set configuration
 *   namespaces  Manage namespaces
 *   status      Show system status
 *   ssh-test    Test SSH tunnel setup
 *   help        Show help message
 */

import { startStdioMode } from "../src/cli/stdio.js";
import { handleHttpCommand } from "../src/cli/http.js";
import { runHumanCLI } from "../src/cli/human.js";
import { runEmbeddingsCLI } from "../src/cli/embeddings.js";
import { runSearchIndexCLI } from "../src/cli/search-index.js";
import { closeAllConnections } from "../src/duckdb/connection.js";
import { installService, manageService } from "../src/cli/service.js";
import http from "http";
import path from "path";
import os from "os";
import fs from "fs";

/**
 * Show help message
 */
function showHelp() {
  console.log(
    `
DuckBrain v1.0.0 - AI Memory System

Usage: duckbrain <command> [options]

Commands:
  stdio              Start MCP server for local Claude
  http               Start MCP server with HTTP transport
  service            Manage systemd service
  remember <key>     Remember a memory (body via --content=, --text=, or stdin)
  recall             Query memories
  search <query>     Keyword full-text search (offline; index refreshes automatically)
  search-index       Manage the keyword search index (rebuild|status|install-hooks)
  list-keys          Browse memory structure
  forget <id>        Delete a memory
  config             Show or set configuration
  namespace(s)       Manage namespaces
  pull               Pull changes from remote
  push               Push changes to remote
  remote             Configure remote repository
  status             Show system status
  token              Generate API token for HTTP authentication
  ssh-test           Test SSH tunnel setup
  ssh-connect        Connect to remote DuckBrain via SSH tunnel
  servers            Manage server connections (list|add|remove)
  squash             Compact old partitions
  query              Read-only SQL over a namespace (SELECT ... or --template)
  embeddings         Manage embedding cache (rebuild|status|install-hooks|providers)
  s3                 Native S3 sync/query (status|sync|query|config)
  help               Show this help

HTTP Options:
  --port=PORT        HTTP server port (default: 3000)
  --bind-all         Bind to all interfaces (0.0.0.0) instead of localhost
  --auth=TYPE        Authentication type: none, basic, apikey (default: apikey; use none only for explicit local mode)
  --auth-file=PATH   Read auth users/apiKeys from PATH instead of
                     ~/.duckbrain/auth.json (env: DUCKBRAIN_AUTH_FILE);
                     the file must exist — for scratch/test daemons
  --rate-limit=N     Requests per minute per IP (default: 100)
  --unix-socket=PATH     Also listen on a Unix domain socket at PATH
  --unix-socket-mode=OCTAL  Socket file permissions (default: 0660)
  --unix-socket-group=NAME  Chown socket to group NAME or numeric GID

Service Commands:
  service install [--system]  Install as systemd service
  service start               Start the service
  service stop                Stop the service
  service restart             Restart the service
  service status              Show service status

Options:
  --namespace=NAME   Select namespace (default: config defaultNamespace)
  --socket=NAME      Use remote connection via Unix socket
  --version, -v      Print the CLI version and exit
  --help             Show this help

Examples:
  duckbrain stdio
  duckbrain http --port=3000
  duckbrain http --auth=basic --rate-limit=60
  duckbrain http --bind-all --port=8080
  duckbrain service install
  duckbrain service start
  duckbrain remember /contacts/alice --domain=person --attr='{"name":"Alice"}' --content='Met at conference'
  duckbrain echo "project notes body" | duckbrain remember /notes/alpha --domain=raw_note
  duckbrain recall --prefix=/projects/
  duckbrain search "GAP-020"
  duckbrain search-index rebuild
  duckbrain list-keys --depth=3 --limit=20
  duckbrain forget abc-123 --reason="obsolete"
  duckbrain status --namespace=default
  duckbrain ssh-connect --host=user@server --name=prod
  duckbrain --socket=prod status
  duckbrain servers list
  duckbrain servers add --name=prod --host=user@server
  duckbrain query "SELECT key, timestamp FROM memories WHERE key LIKE '/projects/%'"
  duckbrain query --template cost-series
`.trim(),
  );
}

/**
 * Resolve the CLI version from package.json at runtime.
 *
 * CLI-VERSION-001: the remote update check (src/ssh/client.ts
 * checkRemoteInstall) runs `duckbrain --version` over SSH and parses
 * /(\d+\.\d+\.\d+)/ from stdout; without a version command the remote exit
 * status is non-zero and the check silently reports "up to date".
 *
 * The package is CommonJS, so __dirname is the correct anchor (never
 * import.meta.url — that is undefined here). PERF-004: the compiled dist/bin
 * entry is two levels below the package root (dist/bin/), while the tsx dev
 * path is one level below (bin/), so walk upward until the duckbrain
 * package.json is found. Falls back to "unknown" so --version never throws.
 */
function readVersion(): string {
  try {
    let dir = __dirname;
    for (let level = 0; level < 5; level++) {
      try {
        const pkgPath = path.join(dir, "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          version?: unknown;
          name?: unknown;
        };
        if (pkg?.name === "duckbrain") {
          return typeof pkg.version === "string" && pkg.version.length > 0
            ? pkg.version
            : "unknown";
        }
      } catch {
        // No readable package.json at this level — keep walking.
      }
      dir = path.dirname(dir);
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Print `duckbrain v<version>` — the exact shape the SSH update-check parser
 * expects (version output like "duckbrain v1.0.0" or "1.0.0").
 */
function printVersion(): void {
  console.log(`duckbrain v${readVersion()}`);
}

/**
 * Run a command on a remote DuckBrain via Unix socket
 */
function runRemoteCLI(
  socketName: string,
  command: string,
  commandArgs: string[],
): Promise<void> {
  const socketPath = path.join(
    os.homedir(),
    ".duckbrain",
    "sockets",
    `${socketName}.sock`,
  );

  if (!fs.existsSync(socketPath)) {
    console.error(`Error: Socket '${socketName}' not found at ${socketPath}`);
    console.error("Active sockets:");
    const socketsDir = path.join(os.homedir(), ".duckbrain", "sockets");
    if (fs.existsSync(socketsDir)) {
      const socks = fs
        .readdirSync(socketsDir)
        .filter((f) => f.endsWith(".sock"));
      if (socks.length === 0) {
        console.error("  (none — run: duckbrain ssh-connect --host=<server>)");
      } else {
        for (const s of socks) {
          console.error(`  ${s.replace(".sock", "")}`);
        }
      }
    }
    process.exit(1);
  }

  const requestBody = JSON.stringify({ command, args: commandArgs });

  const options = {
    socketPath,
    path: "/cli",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(requestBody),
    },
  };

  return new Promise<void>((resolve) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const response = JSON.parse(data);
          if (response.output) console.log(response.output);
          if (response.error) console.error(response.error);
          process.exit(response.exitCode ?? 0);
          resolve();
        } catch {
          console.log(data);
          resolve();
        }
      });
    });

    req.on("error", (err) => {
      console.error(
        `Error: Cannot reach remote DuckBrain via socket '${socketName}': ${err.message}`,
      );
      console.error(
        "Ensure the remote server is running and the SSH tunnel is active.",
      );
      process.exit(1);
    });

    req.write(requestBody);
    req.end();
  });
}

/**
 * Main CLI entry point
 */
async function main() {
  let args = process.argv.slice(2);

  // Extract --socket flag before command routing
  let socketName: string | undefined;
  const socketIdx = args.findIndex((a) => a.startsWith("--socket="));
  if (socketIdx !== -1) {
    socketName = args[socketIdx].split("=")[1];
    args = [...args.slice(0, socketIdx), ...args.slice(socketIdx + 1)];
  } else {
    const bareIdx = args.indexOf("--socket");
    if (bareIdx !== -1 && args[bareIdx + 1]) {
      socketName = args[bareIdx + 1];
      args = [...args.slice(0, bareIdx), ...args.slice(bareIdx + 2)];
    }
  }

  // CLI-VERSION-001: `--version` / `-v` anywhere in the args prints the
  // version and exits 0. Checked BEFORE socket routing so a `--socket=<name>`
  // prefix can never swallow it (and before the help branch, which otherwise
  // would treat it as a command name).
  if (args.includes("--version") || args.includes("-v")) {
    printVersion();
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  // Route --socket commands to remote CLI execution
  if (socketName && command) {
    await runRemoteCLI(socketName, command, commandArgs);
    return;
  }

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    showHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case "stdio":
        await startStdioMode();
        break;

      case "http": {
        // HTTP-HELP-001: the http front door (help short-circuit + flag
        // parsing) lives in src/cli/http.ts now, so vitest can drive it
        // in-process — this bin entry runs main() at import time and must
        // never be imported by a test. A bare --help/-h anywhere in the
        // args prints the options block and exits 0 WITHOUT calling
        // startHttpMode; every other invocation parses and starts exactly
        // as before (same flags, same defaults).
        const { helped } = await handleHttpCommand(commandArgs);
        if (helped) process.exit(0);
        break;
      }

      case "service": {
        const serviceAction = commandArgs[0];
        if (!serviceAction) {
          console.error(
            "Usage: duckbrain service <install|start|stop|restart|status> [--system]",
          );
          process.exit(1);
        }

        if (serviceAction === "install") {
          const isSystem = commandArgs.includes("--system");
          await installService({ system: isSystem });
        } else if (
          ["start", "stop", "restart", "status"].includes(serviceAction)
        ) {
          await manageService(
            serviceAction as "start" | "stop" | "restart" | "status",
          );
        } else {
          console.error(`Unknown service action: ${serviceAction}`);
          console.error("Use: install, start, stop, restart, or status");
          process.exit(1);
        }
        break;
      }

      case "embeddings":
        await runEmbeddingsCLI(commandArgs);
        break;

      case "search-index":
        await runSearchIndexCLI(commandArgs);
        break;

      case "remember":
      case "recall":
      case "search":
      case "list-keys":
      case "forget":
      case "config":
      case "namespace":
      case "namespaces":
      case "pull":
      case "push":
      case "remote":
      case "status":
      case "token":
      case "squash":
      case "ssh-test":
      case "ssh-connect":
      case "servers":
      case "query":
      case "s3":
      case "consolidate":
        await runHumanCLI(command, commandArgs);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "duckbrain help" for usage');
        process.exit(1);
    }
  } catch (error) {
    console.error(
      "Error:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}

// Clear any stale cached connections on startup
// This prevents Napi::Error crashes from corrupted DuckDB singletons
try {
  closeAllConnections();
  console.error("[duckbrain] Cleared stale DuckDB connections");
} catch (e) {
  // Ignore errors during cleanup
}

// Run CLI
main().catch((error) => {
  console.error("[duckbrain] Unhandled error:", error);
  process.exit(1);
});
