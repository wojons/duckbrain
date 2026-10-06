/**
 * HTTP API Client Example
 *
 * Demonstrates how to interact with DuckBrain via its HTTP REST API.
 *
 * The repository is CommonJS ("type": "commonjs" in package.json), so this
 * example is plain CommonJS: run it directly with
 *
 *   node examples/http-api/client.js
 *
 * Keys are filesystem-style paths (they must start with "/", e.g.
 * "/examples/http/test") and content is a plain string. Recall by key uses
 * the documented GET /api/memories/key/:key endpoint; keyword search uses
 * the documented ?contains= parameter (offline full-text search — no
 * embedding provider needed).
 */
// @ts-nocheck


const DEFAULT_BASE_URL = process.env.DUCKBRAIN_URL || "http://localhost:3000";
const DEFAULT_TOKEN = process.env.DUCKBRAIN_TOKEN || null;

class DuckBrainClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, token = DEFAULT_TOKEN } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  getHeaders() {
    const headers = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers["X-API-Key"] = this.token;
    }
    return headers;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    return response.json();
  }

  // Memory operations

  /**
   * Store a memory. `key` must be a filesystem-style path starting with "/";
   * `content` is a plain string; `domain` must be one of the server's
   * domains: person, event, concept, message, config, raw_note.
   */
  async remember({ key, content, domain = "raw_note", metadata = {} }) {
    return this.request("/api/memories", {
      method: "POST",
      body: JSON.stringify({ key, content, domain, attributes: metadata }),
    });
  }

  /**
   * Recall the latest memory stored under an exact key path via the
   * documented GET /api/memories/key/:key endpoint.
   */
  async recall({ key }) {
    return this.request(`/api/memories/key/${key.replace(/^\//, "")}`);
  }

  /**
   * Keyword search over content/key/attributes via the documented
   * ?contains= parameter (offline — no embedding provider required).
   */
  async search({ query, limit = 10 }) {
    const params = new URLSearchParams({
      contains: query,
      limit: String(limit),
    });
    return this.request(`/api/memories?${params}`);
  }

  // Namespace operations
  async listNamespaces() {
    return this.request("/api/namespaces");
  }

  async createNamespace(name) {
    return this.request("/api/namespaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }
}

// Example usage
async function main() {
  const client = new DuckBrainClient();

  try {
    console.log("DuckBrain HTTP API Example\n");

    // Store a memory
    console.log("1. Storing memory...");
    const stored = await client.remember({
      key: "/examples/http/test",
      content: `Hello from HTTP API! (${new Date().toISOString()})`,
    });
    console.log("Stored:", JSON.stringify(stored, null, 2));

    // Recall by key
    console.log("\n2. Recalling memory...");
    const recalled = await client.recall({ key: "/examples/http/test" });
    console.log("Recalled:", JSON.stringify(recalled, null, 2));

    // Keyword search
    console.log("\n3. Searching memories...");
    const results = await client.search({ query: "hello", limit: 5 });
    console.log("Search results:", JSON.stringify(results, null, 2));

    // List namespaces
    console.log("\n4. Listing namespaces...");
    const namespaces = await client.listNamespaces();
    console.log("Namespaces:", JSON.stringify(namespaces, null, 2));
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { DuckBrainClient };
