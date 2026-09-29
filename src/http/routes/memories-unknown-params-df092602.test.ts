/**
 * DF-0926-02 regression: GET /api/memories used to accept ANY query
 * parameter and silently ignore the ones it never read.
 *
 * Root cause: the handler builds its `params` object from a fixed set of
 * keys (prefix, domain, author, q, contains, ...) and never asks whether
 * the request carried anything else. `?key=` and `?query=` — both taught
 * by examples/http-api/client.js at the time of the dogfood run — therefore
 * answered HTTP 200 with the UNFILTERED list. A client that believed it had
 * recalled one key, or run one search, silently received every memory: a
 * silent wrong result, which is worse than an error because the caller has
 * no signal that its filter was dropped.
 *
 * The fix refuses unknown query params with 400 VALIDATION_ERROR and lists
 * the accepted names. These tests pin both directions of that contract:
 *
 *  - unknown names are refused, and are never answered with a list;
 *  - every query param the API documentation advertises for this endpoint
 *    is accepted (so the allow-list and docs/api/http-api.md cannot drift).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import * as fs from "fs";
import * as path from "path";

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(method: string, path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        Host: "localhost",
        "Content-Type": "application/json",
      },
    };

    const req = http.request(options, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * The list of accepted parameters the route advertises in its 400 message —
 * the text after "Valid parameters:", comma-separated.
 */
function advertisedParams(message: string): string[] {
  const marker = "Valid parameters:";
  const at = message.indexOf(marker);
  expect(at, `400 message must list valid parameters: ${message}`).toBeGreaterThan(-1);
  return message
    .slice(at + marker.length)
    .split(",")
    .map((name) => name.trim().replace(/\.$/, ""))
    .filter((name) => name.length > 0);
}

/**
 * Query-param names documented for `GET /api/memories` in
 * docs/api/http-api.md (the endpoint's own table, parsed — not copied —
 * so a documented param that the route ignores fails this file).
 */
function documentedParams(): string[] {
  const doc = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "docs", "api", "http-api.md"),
    "utf8",
  );
  const heading = "#### `GET /api/memories`";
  const start = doc.indexOf(heading);
  expect(start, "docs/api/http-api.md must document GET /api/memories").toBeGreaterThan(-1);
  const rest = doc.slice(start + heading.length);
  const end = rest.indexOf("\n#### ");
  const section = end === -1 ? rest : rest.slice(0, end);

  const names: string[] = [];
  for (const line of section.split("\n")) {
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (row) names.push(row[1]);
  }
  return names;
}

describe("DF-0926-02: GET /api/memories rejects undocumented query params", () => {
  beforeAll(async () => {
    const app = createHttpServer({ authType: "none" });
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") port = addr.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  it("rejects the undocumented ?key= with 400 — never the unfiltered list", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?key=%2Fexamples%2Fhttp%2Ftest",
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toContain("'key'");
    // The regression itself: a list body told the client its filter worked.
    expect(body.items).toBeUndefined();
    expect(body.memories).toBeUndefined();
  });

  it("rejects the undocumented ?query= with 400 and points at ?q= / ?contains=", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?query=zebra",
    );

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toContain("'query'");
    expect(body.error).toContain("?q=");
    expect(body.error).toContain("?contains=");
    expect(body.items).toBeUndefined();
  });

  it("rejects any other unknown param (the class, not just the two proven ones)", async () => {
    for (const param of ["bogus=1", "search=zebra", "keys=%2Fx"]) {
      const { status, body } = await httpRequest(
        "GET",
        `/api/memories?${param}`,
      );
      expect(status, param).toBe(400);
      expect(body.code, param).toBe("VALIDATION_ERROR");
      expect(body.items, param).toBeUndefined();
    }
  });

  it("rejects a bare `attr.` with no attribute name", async () => {
    const { status, body } = await httpRequest("GET", "/api/memories?attr.=x");

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("lists the valid parameters in the 400 message", async () => {
    const { status, body } = await httpRequest("GET", "/api/memories?bogus=1");

    expect(status).toBe(400);
    const advertised = advertisedParams(body.error);
    // Guard against a vacuous parse: the documented core params must be there.
    for (const name of ["prefix", "domain", "q", "contains", "limit", "namespace"]) {
      expect(advertised, body.error).toContain(name);
    }
    // ...and the repeatable attribute form, which is a documented prefix.
    expect(advertised).toContain("attr.<name>");
  });

  it("advertises exactly the params docs/api/http-api.md documents (no drift either way)", async () => {
    const { body } = await httpRequest("GET", "/api/memories?bogus=1");
    const advertised = advertisedParams(body.error);
    const documented = documentedParams();

    // A non-empty, plausible parse — otherwise the comparison is vacuous.
    expect(documented.length).toBeGreaterThan(8);
    expect(documented).toContain("prefix");
    expect(documented).toContain("limit");
    expect(documented).toContain("attr.<name>");

    // Every documented param is accepted...
    for (const name of documented) {
      expect(advertised, `documented param '${name}' must be accepted`).toContain(name);
    }
    // ...and nothing is accepted that the docs do not advertise.
    for (const name of advertised) {
      expect(documented, `accepted param '${name}' must be documented`).toContain(name);
    }
  });

  it("keeps accepting every param the endpoint supports (including attr.<name>)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories?namespace=default&limit=5&offset=0&domain=config" +
        "&prefix=%2Fexamples%2F&author=nobody%40example.com&historical=true" +
        "&allNamespaces=false&attr.tick=1",
    );

    expect(status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.limit).toBe(5);
  });

  it("keeps the documented single-key route working (the ?key= replacement)", async () => {
    const { status, body } = await httpRequest(
      "GET",
      "/api/memories/key/definitely/not/stored?namespace=default",
    );

    // A missing key is an honest 404 — NOT a silent full list.
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(body.items).toBeUndefined();
  });
});
