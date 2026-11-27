import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { authMiddleware } from "../../auth/middleware";
import { createNamespaceRoutes } from "./namespaces";
import { createNamespaceTool, deleteNamespaceTool, switchNamespaceTool } from "../../mcp/tools/namespace";
import type { AuthPrincipal } from "../../auth/middleware";
import { updateConfig } from "../../config/index";

describe("namespace administration authorization", () => {
  let root: string;
  let oldRoot: string | undefined;
  let oldConfig: string | undefined;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-admin-test-"));
    oldRoot = process.env.DUCKBRAIN_NAMESPACES_PATH;
    oldConfig = process.env.DUCKBRAIN_CONFIG_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = path.join(root, "namespaces");
    process.env.DUCKBRAIN_CONFIG_PATH = path.join(root, "duckbrain.config.json");
    fs.mkdirSync(process.env.DUCKBRAIN_NAMESPACES_PATH);
    const app = express();
    app.use(authMiddleware({ type: "apikey", apiKeys: [
      { key: "writer-key", name: "writer", roles: ["writer"], namespaces: ["target"], tableGrants: { widgets: "write" } },
      { key: "analyst-key", name: "analyst", roles: ["analyst"], namespaces: ["target"] },
      { key: "admin-key", name: "admin", roles: ["admin"], namespaces: ["target"] },
      { key: "other-key", name: "other", roles: ["admin"], namespaces: ["other"] },
    ] }));
    app.use(express.json());
    app.use("/api/namespaces", createNamespaceRoutes);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    base = `http://127.0.0.1:${address.port}/api/namespaces`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    if (oldRoot === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH; else process.env.DUCKBRAIN_NAMESPACES_PATH = oldRoot;
    if (oldConfig === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH; else process.env.DUCKBRAIN_CONFIG_PATH = oldConfig;
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function request(key: string, method: string, suffix: string, body: object) {
    return fetch(base + suffix, { method, headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  it("denies non-admins and out-of-scope admins without mutations; permits scoped admins", async () => {
    const directory = path.join(root, "namespaces", "target");
    for (const key of ["writer-key", "analyst-key", "other-key"]) {
      expect((await request(key, "POST", "", { name: "target" })).status).toBe(403);
      expect(fs.existsSync(directory)).toBe(false);
    }
    expect((await request("admin-key", "POST", "", { name: "target" })).status).toBe(201);
    fs.writeFileSync(path.join(directory, "sentinel"), "keep");
    const config = fs.readFileSync(process.env.DUCKBRAIN_CONFIG_PATH!, "utf8");
    for (const key of ["writer-key", "analyst-key", "other-key"]) {
      expect((await request(key, "POST", "/switch", { name: "target" })).status).toBe(403);
      expect((await request(key, "DELETE", "/target", { confirm: true })).status).toBe(403);
      expect(fs.readFileSync(path.join(directory, "sentinel"), "utf8")).toBe("keep");
      expect(fs.readFileSync(process.env.DUCKBRAIN_CONFIG_PATH!, "utf8")).toBe(config);
    }
    expect((await request("bad-key", "POST", "/switch", { name: "target" })).status).toBe(401);
    expect((await request("admin-key", "POST", "/switch", { name: "target" })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(process.env.DUCKBRAIN_CONFIG_PATH!, "utf8")).defaultNamespace).toBe("target");
    updateConfig(root, { defaultNamespace: "default" });
    expect((await request("admin-key", "DELETE", "/target", { confirm: true })).status).toBe(200);
    expect(fs.existsSync(directory)).toBe(false);
  });
  it("denies handler writer even with table write grants", async () => {
    expect((await request("admin-key", "POST", "", { name: "target" })).status).toBe(201);
    fs.writeFileSync(path.join(root, "namespaces", "target", "sentinel"), "keep");
    const principal: AuthPrincipal = { name: "writer", authenticated: true, tokenType: "apikey", roles: ["writer"], namespaces: ["target"], tableGrants: { widgets: "write" } };
    const ctx = { principal };
    expect((await createNamespaceTool({ name: "target", setDefault: false }, ctx)).reason).toBe("role");
    expect((await switchNamespaceTool({ name: "target" }, ctx)).reason).toBe("role");
    expect((await deleteNamespaceTool({ name: "target", confirm: true }, ctx)).reason).toBe("role");
    expect(fs.readFileSync(path.join(root, "namespaces", "target", "sentinel"), "utf8")).toBe("keep");
    updateConfig(root, { defaultNamespace: "default" });
    expect((await request("admin-key", "DELETE", "/target", { confirm: true })).status).toBe(200);
    expect(fs.existsSync(path.join(root, "namespaces", "target"))).toBe(false);
  });
});
