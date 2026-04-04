/**
 * HTTP API Client Example
 * 
 * Demonstrates how to interact with DuckBrain via HTTP REST API
 */

class DuckBrainClient {
  constructor({ baseUrl = 'http://localhost:3000', token = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...options.headers
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    return response.json();
  }

  // Memory operations
  async remember({ key, content, metadata = {} }) {
    return this.request('/api/memories', {
      method: 'POST',
      body: JSON.stringify({ key, content, metadata })
    });
  }

  async recall({ key, limit = 10 }) {
    const params = new URLSearchParams({ key, limit: String(limit) });
    return this.request(`/api/memories?${params}`);
  }

  async search({ query, limit = 10 }) {
    const params = new URLSearchParams({ query, limit: String(limit) });
    return this.request(`/api/memories?${params}`);
  }

  // Namespace operations
  async listNamespaces() {
    return this.request('/api/namespaces');
  }

  async createNamespace(name) {
    return this.request('/api/namespaces', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
  }
}

// Example usage
async function main() {
  const client = new DuckBrainClient({
    baseUrl: process.env.DUCKBRAIN_URL || 'http://localhost:3000',
    token: process.env.DUCKBRAIN_TOKEN
  });

  try {
    console.log('DuckBrain HTTP API Example\n');

    // Store a memory
    console.log('1. Storing memory...');
    const stored = await client.remember({
      key: 'examples/http/test',
      content: {
        message: 'Hello from HTTP API!',
        timestamp: new Date().toISOString()
      }
    });
    console.log('Stored:', JSON.stringify(stored, null, 2));

    // Recall by key
    console.log('\n2. Recalling memory...');
    const recalled = await client.recall({ key: 'examples/http/test' });
    console.log('Recalled:', JSON.stringify(recalled, null, 2));

    // Search
    console.log('\n3. Searching memories...');
    const results = await client.search({ query: 'hello', limit: 5 });
    console.log('Search results:', JSON.stringify(results, null, 2));

    // List namespaces
    console.log('\n4. Listing namespaces...');
    const namespaces = await client.listNamespaces();
    console.log('Namespaces:', JSON.stringify(namespaces, null, 2));

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { DuckBrainClient };
