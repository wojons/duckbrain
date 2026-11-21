import { describe, it, expect } from "vitest";
import { createServer } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { createHttpServer } from "../cli/http";

describe("remote CLI fail-closed boundary", () => {
  it("denies scoped writer commands and audits each request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-cli-grant-"));
    const server = createServer(createHttpServer({ namespacesPath: root, authConfig: {
      type: "apikey", apiKeys: [{ name: "scoped-writer", key: "test-writer-key", roles: ["writer"], namespaces: ["allowed"] }],
    } }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const commands = ["remember", "recall", "list-keys", "forget", "config", "namespaces", "namespace", "pull", "push", "remote", "status", "token", "squash", "ssh-test", "ssh-connect", "servers"];
      const args = ["--namespace=outside", "sensitive-argument"];
      for (const command of commands) {
        const response = await fetch(`http://127.0.0.1:${address.port}/cli`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "test-writer-key" }, body: JSON.stringify({ command, args }) });
        expect(response.status, command).toBe(403);
      }
      const rows = fs.readFileSync(path.join(root, ".duckbrain-audit", "cli.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(commands.length);
      expect(rows.map((row) => row.command)).toEqual(commands);
      for (const row of rows) {
        expect(row).toMatchObject({ principal: "scoped-writer", outcome: "denied", argsHash: createHash("sha256").update(JSON.stringify(args)).digest("hex") });
        expect(JSON.stringify(row)).not.toContain("sensitive-argument");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
