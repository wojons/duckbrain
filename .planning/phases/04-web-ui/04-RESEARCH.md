# Phase 04: Web UI - Research

**Researched:** 2026-04-02 (Updated 2026-04-02)
**Domain:** React-based Web UI for DuckBrain Memory System
**Confidence:** HIGH

## Summary

This research covers the technology stack and architectural patterns for building a data-heavy, real-time web interface for the DuckBrain memory system. The UI must support hundreds to 100,000+ memories, WebSocket/SSE for real-time updates, a file-explorer-style navigation tree, memory editing with version history, namespace management, and a glassmorphism aesthetic inspired by VS Code, Linear, and Supabase.

**Primary recommendation:** Use Vite + React Router v7 + TanStack Table v8 with TanStack Query for data fetching, shadcn/ui for components, React Hook Form for editing, and SSE for real-time updates. All data flows through centralized Express API endpoints that call MCP tool functions directly — maintaining single source of truth for business logic.

**Critical Architecture Update:** The original plan called for DuckDB-WASM in-browser querying. This has been revised to a centralized architecture where all interfaces (MCP, CLI, HTTP, UI) use the same tool functions (`rememberTool`, `recallTool`, `listKeysTool`, `forgetTool`, namespace tools). The HTTP API calls these tools directly, and the UI fetches data via HTTP API calls, NOT via DuckDB-WASM.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Embedded Express UI — mount React/Vue app within existing Express server
- **D-02:** Single-page application (SPA) with client-side routing
- **D-03:** Hybrid rendering — initial HTML from server, then client hydration
- **D-04:** React with TypeScript for UI framework
- **D-05 (REVISED):** ~~DuckDB-WASM for in-browser querying~~ → **API-First Data Access** — All data flows through Express API endpoints
- **D-06:** Tailwind CSS for styling
- **D-07:** Vite for build tooling
- **D-08-D-31:** Complete UI specification including glassmorphism theme, three-panel layout, components, and animations
- **D-19-D-23:** "Architectural Cybernetics" visual design — dark mode only, glassmorphism, specific color palette

### New Requirements (Updated Scope)
- **Memory Editing:** Users can edit memory rows → UI shows new version + all old versions → System creates tombstone internally
- **Namespace Management:** Create, list, switch namespaces via UI
- **Settings/Configuration:** Manage DuckBrain settings through UI
- **API-Only Queries:** All data flows through Express API → returns JSON → UI displays
- **WebSocket/SSE:** Real-time updates with manual pause/refresh option
- **Responsive:** Mobile, tablet, desktop support
- **Complete Feature Parity:** All features working for single/multi-user, single/multi-namespace

### the agent's Discretion
- Exact timing curves for animations (easing functions)
- Responsive breakpoints for mobile/tablet (desktop-first for Phase 4)
- Error boundary fallback UI design
- Service worker for offline capability (optional enhancement)
- Form validation strategies
- Optimistic update implementation details

### Deferred Ideas (OUT OF SCOPE)
- **Real-time Collaboration** — Multiple users editing simultaneously (future)
- **Visual Graph View** — Force-directed graph of memory relationships (future)
- **Mobile App** — Native iOS/Android apps (out of scope per PROJECT.md)
- **Theming/Customization** — User-defined themes, dark mode (could be Phase 4.x)
- **Offline Support** — Service worker, local storage sync (enhancement)
- **Import/Export UI** — Visual import from other tools (future)
- **Admin Dashboard** — System metrics, user management (enterprise future)

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UI-01 | Web interface — File-explorer-style UI showing memory tree and timeline | TanStack Table + custom tree component |
| UI-02 (REVISED) | ~~DuckDB-WASM mode~~ → API-First mode — All queries via HTTP API, returns JSON | Express routes calling MCP tool functions |
| UI-03 | Embedded Express — Optional bundled web server with MCP | Express static file serving + API routes |
| UI-04 | Memory Editing — Edit memories, view version history, tombstone creation | React Hook Form + optimistic updates + PUT endpoint |
| UI-05 | Namespace Management — Create, list, switch namespaces via UI | API endpoints + Zustand store |
| UI-06 | Settings/Configuration — Manage DuckBrain settings | Form components + API persistence |
| UI-07 | Real-time Updates — SSE for live updates with pause/refresh | EventSource + TanStack Query integration |
| UI-08 | Responsive Design — Mobile, tablet, desktop layouts | Tailwind responsive + conditional layouts |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| react | 19.x | UI framework | Established, TypeScript native, large ecosystem |
| react-dom | 19.x | DOM renderer | Required companion to React |
| react-router | 7.x | Client-side routing | Industry standard, excellent type safety |
| @tanstack/react-table | 8.x | Data table/grid | Headless, virtualized, 100k+ row support |
| @tanstack/react-query | 5.x | Server state management | Caching, background updates, stale-while-revalidate |
| @tanstack/react-virtual | 3.x | Virtual scrolling | Essential for 100k+ row performance |

### UI & Styling
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| tailwindcss | 4.x | Utility-first CSS | Locked by D-06, excellent for custom themes |
| shadcn/ui | 2025 | Component primitives | Copy-paste components, full control, accessible |
| lucide-react | 0.x | Icon library | Locked by D-23, modern, tree-shakeable |
| clsx | 2.x | Conditional classes | Lightweight, standard for Tailwind projects |
| tailwind-merge | 2.x | Merge Tailwind classes | Prevents class conflicts |

### State Management
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zustand | 5.x | Client-side state | UI state, sidebar collapse, theme, selected memory |
| @tanstack/react-query | 5.x | Server state | All API calls, caching, real-time sync |

### Form Handling & Editing
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| react-hook-form | 7.x | Form state management | Memory editing, namespace creation, settings |
| @hookform/resolvers | 3.x | Validation resolvers | Zod/yup integration for form validation |
| zod | 3.x | Schema validation | Form validation, API response validation |

### Real-Time
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| native EventSource | - | SSE client | Built-in, sufficient for server→client pushes |
| ws (server) | 8.x | WebSocket server | If bidirectional needed (fallback option) |

### Build Tools
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vite | 6.x | Build tool | Locked by D-07, fastest HMR, excellent DX |
| @vitejs/plugin-react | 4.x | React plugin | SWC-based, fast builds |
| typescript | 5.x | Type checking | Locked by D-04 |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Vite | Next.js | Next.js has SSR complexity we don't need; Vite simpler for embedded SPA |
| TanStack Table | AG Grid | AG Grid excellent but heavier bundle, licensing considerations |
| SSE | WebSocket | WebSocket better for bidirectional, but SSE simpler for server→client only |
| Zustand | Redux | Redux overkill for this scope; Zustand simpler API |
| shadcn/ui | Radix directly | shadcn/ui wraps Radix with better defaults |
| React Hook Form | Formik | Formik has more boilerplate; RHF is lighter, better performance |

**Installation:**
```bash
# Core framework
npm install react react-dom react-router

# Data management
npm install @tanstack/react-table @tanstack/react-query @tanstack/react-virtual zustand

# UI components (shadcn/ui uses these)
npm install tailwindcss @tailwindcss/postcss postcss lucide-react clsx tailwind-merge

# Form handling
npm install react-hook-form @hookform/resolvers zod

# Dev dependencies
npm install -D typescript @types/react @types/react-dom @vitejs/plugin-react
```

**Version verification:** All versions based on current npm registry as of 2026-04-02. React 19 is latest stable, React Router 7 is latest major, TanStack packages are v5 (Query) and v8 (Table) stable.

## Corrected Architecture

### Centralized Tool Pattern

The DuckBrain architecture follows a **centralized tool pattern** where all interfaces use the same core business logic:

```
┌─────────────────────────────────────────────────────────────────┐
│                        INTERFACES                               │
├─────────────┬─────────────┬─────────────┬─────────────────────┤
│    MCP      │    CLI      │    HTTP     │      Web UI         │
│  (Tools)    │  (Commands) │  (Routes)   │   (React SPA)       │
└──────┬──────┴──────┬──────┴──────┬──────┴──────────┬──────────┘
       │             │             │                 │
       └─────────────┴─────────────┴─────────────────┘
                         │
       ┌─────────────────┴─────────────────┐
       │           MCP TOOLS                 │
       │  ┌───────────────────────────────┐  │
       │  │ • rememberTool()              │  │
       │  │ • recallTool()                │  │
       │  │ • listKeysTool()              │  │
       │  │ • forgetTool()                │  │
       │  │ • createNamespaceTool()       │  │
       │  │ • listNamespacesTool()        │  │
       │  │ • switchNamespaceTool()       │  │
       │  └───────────────────────────────┘  │
       └─────────────────────────────────────┘
                         │
       ┌─────────────────┴─────────────────┐
       │           STORAGE LAYER             │
       │  ┌───────────────────────────────┐  │
       │  │ • JSONL files                 │  │
       │  │ • DuckDB (server-side)        │  │
       │  │ • Git synchronization         │  │
       │  └───────────────────────────────┘  │
       └─────────────────────────────────────┘
```

**Key Principle:** The MCP tools in `src/mcp/tools/*.ts` contain ALL business logic. HTTP API routes are thin wrappers that call these tools. The UI calls HTTP API endpoints which return JSON — NOT querying DuckDB-WASM directly.

### API Design Pattern

```typescript
// Express routes call MCP tools directly

// POST /api/memories → rememberTool()
app.post('/api/memories', async (req, res) => {
  const result = await rememberTool({
    key: req.body.key,
    domain: req.body.domain,
    content: req.body.content,
    // ... other fields
  });
  res.json(result);
});

// GET /api/memories → recallTool()
app.get('/api/memories', async (req, res) => {
  const result = await recallTool({
    keyPrefix: req.query.prefix,
    limit: req.query.limit,
    // ... filters
  });
  res.json(result);
});

// DELETE /api/memories/:id → forgetTool()
app.delete('/api/memories/:id', async (req, res) => {
  const result = await forgetTool({ id: req.params.id });
  res.json(result);
});

// GET /api/keys → listKeysTool()
app.get('/api/keys', async (req, res) => {
  const result = await listKeysTool({ prefix: req.query.prefix });
  res.json(result);
});

// POST /api/namespaces → createNamespaceTool()
app.post('/api/namespaces', async (req, res) => {
  const result = await createNamespaceTool({ name: req.body.name });
  res.json(result);
});

// GET /api/namespaces → listNamespacesTool()
app.get('/api/namespaces', async (req, res) => {
  const result = await listNamespacesTool();
  res.json(result);
});

// PUT /api/memories/:id → Edit: creates tombstone + new version
app.put('/api/memories/:id', async (req, res) => {
  // 1. Fetch existing memory
  // 2. Create tombstone using forgetTool()
  // 3. Create new version using rememberTool() with new content
  // 4. Return new memory with version history
  const result = await editMemoryTool({
    id: req.params.id,
    updates: req.body
  });
  res.json(result);
});
```

### Benefits of Centralized Architecture

1. **Single Source of Truth:** Business logic lives in one place (MCP tools)
2. **Consistency:** All interfaces behave identically
3. **Testability:** Test tools once, used everywhere
4. **Maintainability:** Changes only needed in tool layer
5. **Security:** Auth/validation at tool layer, not duplicated

## API-First Data Access

### Client-Side Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                         REACT UI                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐    │
│  │  Components │  │  TanStack   │  │   Zustand Store     │    │
│  │             │← │   Query     │← │ (UI State)          │    │
│  │             │  │  (Cache)    │  │                     │    │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────────┘    │
│         │                │                                     │
│         │ fetch/POST     │                                     │
│         │                │                                     │
│  ┌──────▼────────────────▼──────┐                              │
│  │      API Client (fetch)      │                              │
│  │  • Error handling            │                              │
│  │  • Auth headers              │                              │
│  │  • Request/response logging   │                              │
│  └──────────────┬───────────────┘                              │
└─────────────────┼──────────────────────────────────────────────┘
                  │ HTTP (JSON)
┌─────────────────▼──────────────────────────────────────────────┐
│                    EXPRESS SERVER                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Middleware: Auth, CORS, JSON parsing, rate limiting     │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│                             │                                    │
│  ┌──────────────────────────▼───────────────────────────────┐   │
│  │              API ROUTES                                    │   │
│  │  /api/memories    →  recallTool/rememberTool/forgetTool   │   │
│  │  /api/keys        →  listKeysTool                          │   │
│  │  /api/namespaces  →  namespace tools                     │   │
│  │  /api/events      →  SSE endpoint                        │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                             │                                    │
│  ┌──────────────────────────▼───────────────────────────────┐   │
│  │              MCP TOOLS (src/mcp/tools/*.ts)              │   │
│  │  • rememberTool()  • recallTool()  • forgetTool()        │   │
│  │  • listKeysTool()  • namespace tools                     │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
└─────────────────────────────┼──────────────────────────────────────┘
                              │
┌─────────────────────────────▼──────────────────────────────────────┐
│                          STORAGE                                    │
│  • JSONL files (namespaces/{name}/**/*.jsonl)                       │
│  • DuckDB (server-side for complex queries)                         │
└────────────────────────────────────────────────────────────────────┘
```

### API Client Pattern

```typescript
// lib/api-client.ts
const API_BASE = '/api';

async function api<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json();
}

// Typed API methods
export const memoriesApi = {
  list: (params?: { prefix?: string; limit?: number }) =>
    api<Memory[]>('/memories', {
      method: 'GET',
      // query params handling
    }),
  
  create: (data: CreateMemoryInput) =>
    api<Memory>('/memories', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  
  update: (id: string, data: UpdateMemoryInput) =>
    api<Memory>(`/memories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  
  delete: (id: string) =>
    api<void>(`/memories/${id}`, {
      method: 'DELETE',
    }),
  
  getVersions: (id: string) =>
    api<MemoryVersion[]>(`/memories/${id}/versions`),
};

export const keysApi = {
  list: (prefix?: string) =>
    api<KeyNode[]>('/keys', {
      // query params
    }),
};

export const namespacesApi = {
  list: () => api<Namespace[]>('/namespaces'),
  create: (name: string) =>
    api<Namespace>('/namespaces', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  switch: (name: string) =>
    api<void>('/namespaces/switch', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
};
```

### TanStack Query Integration

```typescript
// hooks/use-memories.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { memoriesApi } from '@/lib/api-client';

// List memories with caching
export function useMemories(params?: { prefix?: string; limit?: number }) {
  return useQuery({
    queryKey: ['memories', params],
    queryFn: () => memoriesApi.list(params),
    staleTime: 30000, // 30 seconds
  });
}

// Create memory with optimistic updates
export function useCreateMemory() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: memoriesApi.create,
    onSuccess: () => {
      // Invalidate and refetch memories list
      queryClient.invalidateQueries({ queryKey: ['memories'] });
      queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
  });
}

// Update memory with optimistic updates
export function useUpdateMemory() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMemoryInput }) =>
      memoriesApi.update(id, data),
    onSuccess: (_, variables) => {
      // Invalidate specific memory and lists
      queryClient.invalidateQueries({
        queryKey: ['memories', variables.id]
      });
      queryClient.invalidateQueries({ queryKey: ['memories'] });
    },
  });
}

// Forget memory
export function useForgetMemory() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: memoriesApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memories'] });
      queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
  });
}
```

## Memory Editing Flow

### Edit Memory Workflow

```
User clicks "Edit" in Inspector Panel
           │
           ▼
┌──────────────────────────────┐
│  Open Edit Modal/Panel       │
│  - Pre-populate form         │
│  - Show current values       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  User modifies fields          │
│  - React Hook Form validation │
│  - Real-time validation        │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  User clicks "Save"            │
│  - Optimistic UI update       │
│  - Show loading state         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  PUT /api/memories/:id       │
│  - Server receives edit       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Server Processing:           │
│  1. Fetch existing memory     │
│  2. Create tombstone via      │
│     forgetTool()              │
│  3. Create new version via    │
│     rememberTool()            │
│  4. Return new + history      │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  UI Updates:                   │
│  - Show success toast         │
│  - Update cache (TanStack)    │
│  - Refresh memory list          │
│  - Update version history       │
└──────────────────────────────┘
```

### Version History Display

```typescript
// components/memory-version-history.tsx
interface MemoryVersionHistoryProps {
  memoryId: string;
}

export function MemoryVersionHistory({ memoryId }: MemoryVersionHistoryProps) {
  const { data: versions } = useMemoryVersions(memoryId);
  
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-pristine">Version History</h3>
      <div className="space-y-2">
        {versions?.map((version, index) => (
          <div
            key={version.id}
            className={`
              p-3 rounded-lg border
              ${index === 0 
                ? 'border-azure/30 bg-azure/5' 
                : 'border-glassBorder bg-glass'}
            `}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-clinical">
                {index === 0 ? 'Current' : `Version ${versions.length - index}`}
              </span>
              <span className="text-xs text-clinical">
                {formatDate(version.timestamp)}
              </span>
            </div>
            {version.isTombstone && (
              <span className="text-xs text-amber">Tombstone</span>
            )}
            <div className="mt-2 text-sm text-pristine">
              {version.contentPreview}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### Edit Form Implementation

```typescript
// components/memory-edit-form.tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

const editMemorySchema = z.object({
  key: z.string().min(1, 'Key is required'),
  domain: z.string().min(1, 'Domain is required'),
  content: z.string().min(1, 'Content is required'),
  attributes: z.record(z.unknown()).optional(),
});

type EditMemoryFormData = z.infer<typeof editMemorySchema>;

interface MemoryEditFormProps {
  memory: Memory;
  onSubmit: (data: EditMemoryFormData) => Promise<void>;
  onCancel: () => void;
}

export function MemoryEditForm({ memory, onSubmit, onCancel }: MemoryEditFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EditMemoryFormData>({
    resolver: zodResolver(editMemorySchema),
    defaultValues: {
      key: memory.key,
      domain: memory.domain,
      content: memory.content,
      attributes: memory.attributes,
    },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <label className="label">Key Path</label>
        <input
          {...register('key')}
          className="input-mono"
          disabled // Key path usually immutable
        />
      </div>
      
      <div>
        <label className="label">Domain</label>
        <select {...register('domain')} className="select">
          <option value="concept">Concept</option>
          <option value="person">Person</option>
          <option value="project">Project</option>
        </select>
        {errors.domain && (
          <span className="error-text">{errors.domain.message}</span>
        )}
      </div>
      
      <div>
        <label className="label">Content</label>
        <textarea
          {...register('content')}
          rows={6}
          className="textarea"
        />
        {errors.content && (
          <span className="error-text">{errors.content.message}</span>
        )}
      </div>
      
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </form>
  );
}
```

## Namespace Management

### Namespace UI Patterns

```typescript
// stores/namespace-store.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface NamespaceStore {
  currentNamespace: string;
  namespaces: string[];
  isLoading: boolean;
  setCurrentNamespace: (name: string) => void;
  loadNamespaces: () => Promise<void>;
  createNamespace: (name: string) => Promise<void>;
}

export const useNamespaceStore = create<NamespaceStore>()(
  persist(
    (set, get) => ({
      currentNamespace: 'default',
      namespaces: [],
      isLoading: false,
      
      setCurrentNamespace: (name) => {
        set({ currentNamespace: name });
        // Trigger data refetch for new namespace
        queryClient.invalidateQueries();
      },
      
      loadNamespaces: async () => {
        set({ isLoading: true });
        try {
          const namespaces = await namespacesApi.list();
          set({ namespaces: namespaces.map(n => n.name), isLoading: false });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },
      
      createNamespace: async (name) => {
        await namespacesApi.create(name);
        await get().loadNamespaces();
        get().setCurrentNamespace(name);
      },
    }),
    {
      name: 'namespace-storage',
      partialize: (state) => ({ currentNamespace: state.currentNamespace }),
    }
  )
);
```

### Namespace Selector Component

```typescript
// components/namespace-selector.tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Plus, ChevronDown, Database } from 'lucide-react';

export function NamespaceSelector() {
  const { currentNamespace, namespaces, createNamespace } = useNamespaceStore();
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 px-3 py-1.5 glass-panel rounded-lg hover:bg-glassHover transition-colors">
          <Database className="w-4 h-4 text-azure" />
          <span className="text-sm text-pristine">{currentNamespace}</span>
          <ChevronDown className="w-4 h-4 text-clinical" />
        </button>
      </DropdownMenuTrigger>
      
      <DropdownMenuContent className="w-56 glass-panel">
        <div className="px-2 py-1.5 text-xs text-clinical uppercase tracking-wider">
          Namespaces
        </div>
        
        {namespaces.map((ns) => (
          <DropdownMenuItem
            key={ns}
            onClick={() => useNamespaceStore.getState().setCurrentNamespace(ns)}
            className={ns === currentNamespace ? 'bg-azure/10' : ''}
          >
            <Database className="w-4 h-4 mr-2" />
            {ns}
            {ns === currentNamespace && (
              <span className="ml-auto text-xs text-azure">Active</span>
            )}
          </DropdownMenuItem>
        ))}
        
        <DropdownMenuSeparator />
        
        <DropdownMenuItem onClick={() => setIsCreating(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Create Namespace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

## Real-Time Updates with SSE

### SSE Client Implementation

```typescript
// hooks/use-sse.ts
import { useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

interface UseSSEOptions {
  namespace: string;
  onMessage?: (data: unknown) => void;
  enabled?: boolean;
}

export function useSSE({ namespace, onMessage, enabled = true }: UseSSEOptions) {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectDelayRef = useRef(1000);
  const isPausedRef = useRef(false);

  const connect = useCallback(() => {
    if (!enabled || isPausedRef.current) return;

    const eventSource = new EventSource(`/api/events/${namespace}`);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      reconnectDelayRef.current = 1000; // Reset delay on success
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Handle different event types
        switch (data.type) {
          case 'memory:created':
          case 'memory:updated':
          case 'memory:deleted':
            // Invalidate queries to trigger refetch
            queryClient.invalidateQueries({ queryKey: ['memories'] });
            queryClient.invalidateQueries({ queryKey: ['keys'] });
            break;
          case 'namespace:changed':
            queryClient.invalidateQueries();
            break;
        }
        
        onMessage?.(data);
      } catch (error) {
        console.error('SSE parse error:', error);
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      
      // Exponential backoff with jitter
      setTimeout(() => {
        connect();
      }, reconnectDelayRef.current + Math.random() * 1000);
      
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * 2,
        30000 // Max 30 second delay
      );
    };
  }, [namespace, enabled, onMessage, queryClient]);

  const disconnect = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    disconnect();
  }, [disconnect]);

  const resume = useCallback(() => {
    isPausedRef.current = false;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return disconnect;
  }, [connect, disconnect]);

  return {
    pause,
    resume,
    isPaused: () => isPausedRef.current,
  };
}
```

### Manual Pause/Refresh UI

```typescript
// components/realtime-controls.tsx
import { useState } from 'react';
import { Pause, Play, RefreshCw } from 'lucide-react';

interface RealtimeControlsProps {
  isPaused: boolean;
  onPauseToggle: () => void;
  onRefresh: () => void;
  lastUpdate: Date;
}

export function RealtimeControls({
  isPaused,
  onPauseToggle,
  onRefresh,
  lastUpdate,
}: RealtimeControlsProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await onRefresh();
    setIsRefreshing(false);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onPauseToggle}
        className={`
          p-2 rounded-lg transition-colors
          ${isPaused 
            ? 'bg-amber/10 text-amber border border-amber/30' 
            : 'hover:bg-glassHover text-clinical'}
        `}
        title={isPaused ? 'Resume real-time updates' : 'Pause real-time updates'}
      >
        {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
      </button>
      
      <button
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="p-2 rounded-lg hover:bg-glassHover text-clinical transition-colors"
        title="Refresh now"
      >
        <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
      </button>
      
      <span className="text-xs text-clinical">
        {isPaused ? 'Paused' : `Updated ${formatTimeAgo(lastUpdate)}`}
      </span>
    </div>
  );
}
```

## Architecture Patterns

### Recommended Project Structure
```
packages/
├── ui/                              # React SPA (new)
│   ├── src/
│   │   ├── main.tsx                 # Entry point
│   │   ├── App.tsx                  # Root component with router
│   │   ├── routes/                  # Route components
│   │   │   ├── tree.tsx             # Tree view
│   │   │   ├── timeline.tsx         # Timeline view
│   │   │   ├── search.tsx           # Search results
│   │   │   └── settings.tsx         # Settings page
│   │   ├── components/              # Shared components
│   │   │   ├── layout/              # Layout components
│   │   │   │   ├── sidebar.tsx      # Left navigation
│   │   │   │   ├── inspector.tsx    # Right slide-out panel
│   │   │   │   └── header.tsx       # Top header with omnibar
│   │   │   ├── memory-table.tsx     # TanStack Table wrapper
│   │   │   ├── memory-tree.tsx      # File explorer tree
│   │   │   ├── memory-edit-form.tsx # Edit form with RHF
│   │   │   ├── memory-versions.tsx  # Version history display
│   │   │   ├── namespace-selector.tsx # Namespace dropdown
│   │   │   ├── realtime-controls.tsx # Pause/resume/refresh
│   │   │   └── vitals.tsx           # Stats widgets
│   │   ├── hooks/                   # Custom hooks
│   │   │   ├── use-memories.ts      # Memory queries (API)
│   │   │   ├── use-keys.ts          # Key tree queries
│   │   │   ├── use-namespaces.ts    # Namespace queries
│   │   │   ├── use-sse.ts           # Server-sent events
│   │   │   └── use-settings.ts      # Settings queries
│   │   ├── lib/                     # Utilities
│   │   │   ├── api-client.ts        # HTTP API client
│   │   │   ├── utils.ts             # Helper functions
│   │   │   └── validators.ts        # Zod schemas
│   │   ├── stores/                  # Zustand stores
│   │   │   ├── ui-store.ts          # UI state
│   │   │   └── namespace-store.ts   # Namespace state
│   │   └── styles/
│   │       └── globals.css            # Tailwind + custom CSS
│   ├── index.html
│   ├── vite.config.ts
│   └── tsconfig.json
├── http/                            # Express server (existing)
│   └── src/
│       └── http.ts                  # Add API routes + static serving
└── mcp/                             # MCP tools (existing, reused)
```

### Pattern 1: Centralized Tool Pattern (REVISED)
**What:** All interfaces use same MCP tool functions; HTTP API is thin wrapper
**When to use:** All data operations — queries, mutations, namespace management
**Example:**
```typescript
// Server: Express route calls MCP tool
// src/http/routes/memories.ts
import { rememberTool } from '@/mcp/tools/remember';
import { recallTool } from '@/mcp/tools/recall';
import { forgetTool } from '@/mcp/tools/forget';

app.get('/api/memories', async (req, res) => {
  // Thin wrapper — all logic in recallTool
  const result = await recallTool({
    keyPrefix: req.query.prefix as string,
    limit: parseInt(req.query.limit as string) || 50,
  });
  res.json(result);
});

app.post('/api/memories', async (req, res) => {
  const result = await rememberTool(req.body);
  res.json(result);
});

app.delete('/api/memories/:id', async (req, res) => {
  const result = await forgetTool({ id: req.params.id });
  res.json(result);
});

// Client: API client calls HTTP endpoints
// src/lib/api-client.ts
export const memoriesApi = {
  list: (params?: { prefix?: string; limit?: number }) =>
    api<Memory[]>('/memories', { method: 'GET' }),
  
  create: (data: CreateMemoryInput) =>
    api<Memory>('/memories', { method: 'POST', body: JSON.stringify(data) }),
  
  delete: (id: string) =>
    api<void>(`/memories/${id}`, { method: 'DELETE' }),
};
```

### Pattern 2: TanStack Table with Virtualization
**What:** Display large datasets with virtual scrolling and efficient updates
**When to use:** Timeline view with 100k+ memories
**Example:**
```typescript
// Source: TanStack Table v8 documentation
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

function MemoryTable({ data }: { data: Memory[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  
  const columns = useMemo(() => [
    { accessorKey: 'key', header: 'Key Path' },
    { accessorKey: 'domain', header: 'Domain' },
    { accessorKey: 'timestamp', header: 'Timestamp' },
  ], []);
  
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  
  const { rows } = table.getRowModel();
  
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // row height
  });
  
  return (
    <div ref={parentRef} className="h-[600px] overflow-auto">
      <div style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          return (
            <div
              key={row.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {row.getVisibleCells().map((cell) => (
                <span key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Pattern 3: SSE for Real-Time Updates
**What:** Server-sent events for pushing memory changes to clients
**When to use:** When memories are added/modified by other users/agents
**Example:**
```typescript
// Source: MDN Server-sent events documentation
// Client-side
export function useMemoryEvents(namespace: string) {
  const queryClient = useQueryClient();
  const [isPaused, setIsPaused] = useState(false);
  
  useEffect(() => {
    if (isPaused) return;
    
    const eventSource = new EventSource(`/api/events/${namespace}`);
    
    eventSource.onmessage = (event) => {
      const update = JSON.parse(event.data);
      
      // Handle different event types
      switch (update.type) {
        case 'memory:created':
        case 'memory:updated':
        case 'memory:deleted':
          // Invalidate queries to trigger refetch
          queryClient.invalidateQueries({
            queryKey: ['memories', namespace]
          });
          break;
      }
    };
    
    eventSource.onerror = () => {
      eventSource.close();
      // Reconnect with exponential backoff handled in useSSE hook
    };
    
    return () => eventSource.close();
  }, [namespace, queryClient, isPaused]);
  
  return { isPaused, setIsPaused };
}

// Server-side (Express)
app.get('/api/events/:namespace', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendEvent = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  
  // Subscribe to memory changes
  const unsubscribe = memoryEvents.subscribe(req.params.namespace, sendEvent);
  
  req.on('close', unsubscribe);
});
```

### Pattern 4: Tree Navigation with Lazy Loading
**What:** File-explorer-style tree with expand/collapse and on-demand loading
**When to use:** Memory tree navigation (left sidebar)
**Example:**
```typescript
// Source: React patterns + shadcn/ui Tree component pattern
interface TreeNode {
  id: string;
  name: string;
  path: string;
  type: 'folder' | 'memory';
  children?: TreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
}

function MemoryTree({ rootKey = '' }: { rootKey?: string }) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const { data: keys } = useQuery({
    queryKey: ['keys', rootKey],
    queryFn: () => fetchKeys(rootKey),
  });
  
  const toggleNode = async (path: string) => {
    const node = findNode(nodes, path);
    if (!node || node.type === 'memory') return;
    
    if (!node.isExpanded && !node.children) {
      node.isLoading = true;
      const children = await fetchKeys(path);
      node.children = buildTree(children);
    }
    
    node.isExpanded = !node.isExpanded;
    setNodes([...nodes]);
  };
  
  return (
    <div className="tree-container">
      {nodes.map((node) => (
        <TreeNodeComponent
          key={node.path}
          node={node}
          onToggle={() => toggleNode(node.path)}
          level={0}
        />
      ))}
    </div>
  );
}
```

### Pattern 5: Slide-Out Inspector Panel
**What:** VS Code/Linear-style inspector panel sliding from right
**When to use:** Memory detail view with edit capabilities
**Example:**
```typescript
// Source: Linear/VS Code UI patterns
function InspectorPanel({
  memory,
  isOpen,
  onClose,
  onEdit,
}: {
  memory: Memory | null;
  isOpen: boolean;
  onClose: () => void;
  onEdit: (memory: Memory) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  
  return (
    <div
      className={`
        fixed right-0 top-0 h-full w-[450px]
        transform transition-transform duration-300 ease-in-out
        ${isOpen ? 'translate-x-0' : 'translate-x-full'}
        glass-panel border-l border-glassBorder
      `}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-glassBorder">
        <h2 className="text-lg font-semibold text-pristine">
          {isEditing ? 'Edit Memory' : 'Memory Inspector'}
        </h2>
        <button
          onClick={onClose}
          className="p-2 hover:bg-glassHover rounded-lg transition-colors"
        >
          <X className="w-5 h-5 text-clinical" />
        </button>
      </div>
      
      {/* Content */}
      <div className="p-4 overflow-auto h-[calc(100%-140px)]">
        {memory && isEditing ? (
          <MemoryEditForm
            memory={memory}
            onSubmit={async (data) => {
              await onEdit({ ...memory, ...data });
              setIsEditing(false);
            }}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          memory && <MemoryDetails memory={memory} />
        )}
      </div>
      
      {/* Footer */}
      <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-glassBorder bg-glass">
        <div className="flex gap-2">
          {!isEditing && (
            <>
              <Button variant="secondary" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
              <Button variant="secondary" onClick={() => copyJSON(memory)}>
                Copy JSON
              </Button>
              <Button variant="destructive" onClick={() => forgetMemory(memory.id)}>
                Forget
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

### Pattern 6: Glassmorphism Theme
**What:** Tailwind configuration for Architectural Cybernetics aesthetic
**When to use:** All UI components
**Example:**
```typescript
// Source: CONTEXT.md design specifications
// tailwind.config.ts
import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class', // Always dark per D-19
  theme: {
    extend: {
      colors: {
        midnight: '#0B101E',
        glass: {
          DEFAULT: 'rgba(255, 255, 255, 0.03)',
          hover: 'rgba(255, 255, 255, 0.06)',
          border: 'rgba(255, 255, 255, 0.08)',
        },
        azure: '#00D4FF',
        amber: '#FFB020',
        pristine: '#F8FAFC',
        clinical: '#94A3B8',
        success: '#00FF66',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        'neon-azure': '0 0 12px rgba(0, 212, 255, 0.3)',
        'neon-amber': '0 0 12px rgba(255, 176, 32, 0.3)',
        'inner-azure': 'inset 0 0 12px rgba(0, 212, 255, 0.05)',
      },
      backdropBlur: {
        glass: '16px',
      },
    },
  },
};

// Component classes (globals.css)
@layer components {
  .glass-panel {
    @apply bg-glass backdrop-blur-glass border border-glassBorder rounded-xl;
    background-image: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.05) 0%,
      transparent 100%
    );
  }
  
  .glass-panel-hover:hover {
    @apply bg-glass-hover;
  }
  
  .status-dot-active {
    @apply bg-success rounded-full;
    box-shadow: 0 0 8px rgba(0, 255, 102, 0.6);
  }
}
```

### Anti-Patterns to Avoid
- ~~Direct DuckDB-WASM queries in components~~ → Use API client to call HTTP endpoints
- **Loading all 100k memories at once:** Always use virtualization and pagination
- **Polling for updates:** Use SSE with manual pause/refresh instead of aggressive polling
- **Synchronous tree building:** Build tree structure lazily, not on every render
- **Prop drilling for UI state:** Use Zustand for shared UI state like sidebar collapse
- **Client-side only validation:** Always validate on server too; use Zod for both
- **Optimistic updates without rollback:** Implement error handling to revert on failure

## Runtime State Inventory

This phase creates NEW web UI components — no runtime state migration required. However, note:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — this is new UI layer | N/A |
| Live service config | Express HTTP server exists — add API routes | Code changes only |
| OS-registered state | None — browser-based | N/A |
| Secrets/env vars | API auth tokens for HTTP calls | Store in browser securely (if persisted) |
| Build artifacts | None yet — new SPA | N/A |

## Common Pitfalls

### Pitfall 1: API Response Caching Issues
**What goes wrong:** TanStack Query caches stale data after memory edits
**Why it happens:** Cache invalidation not properly configured
**How to avoid:** 
- Use precise query keys for invalidation
- Invalidate related queries on mutation success
- Consider using `queryClient.setQueryData` for optimistic updates
**Warning signs:** Edited memory doesn't reflect changes in list view

### Pitfall 2: Form State Persistence on Edit
**What goes wrong:** Form shows old values when editing different memory
**Why it happens:** Form not reset when memory prop changes
**How to avoid:**
- Use `reset` from react-hook-form when memory changes
- Use `key` prop to force re-mount: `<MemoryEditForm key={memory.id} />`
- Or use `useEffect` to watch for memory changes
**Code example:**
```typescript
useEffect(() => {
  reset({
    key: memory.key,
    domain: memory.domain,
    content: memory.content,
  });
}, [memory, reset]);
```

### Pitfall 3: Namespace Switch Race Conditions
**What goes wrong:** Data from old namespace appears after switching
**Why it happens:** In-flight requests complete after switch
**How to avoid:**
- Cancel in-flight requests on namespace change
- Use TanStack Query's `queryKey` with namespace prefix
- Show loading state during switch
**Code example:**
```typescript
useQuery({
  queryKey: ['memories', namespace, params], // namespace in key
  queryFn: () => fetchMemories(namespace, params),
});
```

### Pitfall 4: SSE Reconnection Storm
**What goes wrong:** Client reconnects too aggressively after error, overwhelming server
**Why it happens:** Default reconnection logic can be too aggressive
**How to avoid:**
- Implement exponential backoff in reconnection logic
- Add jitter to prevent thundering herd
- Set reasonable reconnection limits
**Code example:**
```typescript
let reconnectDelay = 1000;
const maxReconnectDelay = 30000;

eventSource.onerror = () => {
  eventSource.close();
  setTimeout(() => {
    connectSSE();
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
  }, reconnectDelay + Math.random() * 1000); // jitter
};

eventSource.onopen = () => {
  reconnectDelay = 1000; // reset on success
};
```

### Pitfall 5: Optimistic Update Rollback Failures
**What goes wrong:** Optimistic update not reverted on error, UI shows wrong state
**Why it happens:** Error handler doesn't restore previous cache state
**How to avoid:**
- Store previous cache state before optimistic update
- Implement proper error handling in `onError`
- Use TanStack Query's `onMutate` + `onError` pattern
**Code example:**
```typescript
return useMutation({
  mutationFn: updateMemory,
  onMutate: async (newMemory) => {
    await queryClient.cancelQueries({ queryKey: ['memories'] });
    const previousMemories = queryClient.getQueryData(['memories']);
    queryClient.setQueryData(['memories'], (old) => /* optimistic update */);
    return { previousMemories };
  },
  onError: (err, newMemory, context) => {
    queryClient.setQueryData(['memories'], context?.previousMemories);
  },
});
```

### Pitfall 6: Tailwind CSS Purge Removes Dynamic Classes
**What goes wrong:** Classes generated dynamically (e.g., `bg-${color}-500`) don't work
**Why it happens:** Tailwind purges unused classes at build time
**How to avoid:**
- Use full class names in source: `color === 'azure' ? 'text-azure' : 'text-amber'`
- Or safelist dynamic classes in Tailwind config
- Never use template literals for Tailwind classes
**Warning signs:** Styles missing in production build only

## Code Examples

### Complete Data Fetching Pattern (API-First)
```typescript
// hooks/use-memories.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// API calls go to HTTP endpoints, NOT DuckDB-WASM
const memoriesApi = {
  async fetchTimeline(namespace: string, limit: number = 50) {
    const response = await fetch(
      `/api/memories?namespace=${namespace}&limit=${limit}`
    );
    if (!response.ok) throw new Error('Failed to fetch memories');
    return response.json();
  },
  
  async searchMemories(query: string, filters: Filters) {
    const params = new URLSearchParams({ q: query, ...filters });
    const response = await fetch(`/api/memories/search?${params}`);
    if (!response.ok) throw new Error('Search failed');
    return response.json();
  },
  
  async updateMemory(id: string, updates: Partial<Memory>) {
    const response = await fetch(`/api/memories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error('Failed to update memory');
    return response.json();
  },
  
  async forgetMemory(id: string) {
    const response = await fetch(`/api/memories/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to forget memory');
    return response.json();
  },
};

export function useTimeline(namespace: string) {
  return useQuery({
    queryKey: ['memories', 'timeline', namespace],
    queryFn: () => memoriesApi.fetchTimeline(namespace),
    staleTime: 30000, // 30 seconds
  });
}

export function useUpdateMemory() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<Memory> }) =>
      memoriesApi.updateMemory(id, updates),
    onSuccess: (_, variables) => {
      // Invalidate and refetch
      queryClient.invalidateQueries({ queryKey: ['memories'] });
      queryClient.invalidateQueries({
        queryKey: ['memories', variables.id]
      });
    },
  });
}
```

### Responsive Layout Pattern
```typescript
// components/layout/app-layout.tsx
export function AppLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isTablet = useMediaQuery('(max-width: 1024px)');
  
  // Auto-collapse sidebar on mobile/tablet
  useEffect(() => {
    if (isMobile || isTablet) setSidebarOpen(false);
  }, [isMobile, isTablet]);
  
  return (
    <div className="min-h-screen bg-midnight flex">
      {/* Left Sidebar - collapsible on mobile/tablet */}
      <aside
        className={`
          fixed z-20 h-full
          w-64 transform transition-transform duration-300
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          md:relative md:translate-x-0
          ${isTablet ? 'md:w-0 md:overflow-hidden' : ''}
        `}
      >
        <Sidebar />
      </aside>
      
      {/* Mobile overlay */}
      {sidebarOpen && isMobile && (
        <div
          className="fixed inset-0 bg-black/50 z-10"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      
      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0">
        <Header 
          onMenuClick={() => setSidebarOpen(!sidebarOpen)}
          onMemorySelect={(m) => {
            setSelectedMemory(m);
            setInspectorOpen(true);
          }}
        />
        <div className="flex-1 overflow-auto p-4">
          {children}
        </div>
      </main>
      
      {/* Right Inspector - slide-out */}
      <InspectorPanel
        memory={selectedMemory}
        isOpen={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        onEdit={handleEditMemory}
      />
    </div>
  );
}
```

### Namespace API Integration
```typescript
// hooks/use-namespaces.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export function useNamespaces() {
  return useQuery({
    queryKey: ['namespaces'],
    queryFn: async () => {
      const response = await fetch('/api/namespaces');
      if (!response.ok) throw new Error('Failed to fetch namespaces');
      return response.json();
    },
  });
}

export function useCreateNamespace() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (name: string) => {
      const response = await fetch('/api/namespaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error('Failed to create namespace');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['namespaces'] });
    },
  });
}

export function useSwitchNamespace() {
  return useMutation({
    mutationFn: async (name: string) => {
      const response = await fetch('/api/namespaces/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error('Failed to switch namespace');
      return response.json();
    },
  });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Redux for server state | TanStack Query | 2021+ | Automatic caching, background updates, less boilerplate |
| CSS-in-JS (styled-components) | Tailwind CSS | 2020+ | Smaller bundles, better performance, no runtime cost |
| Class components | Function components + hooks | 2019+ | Better composition, smaller code, easier testing |
| React Table v7 | TanStack Table v8 | 2022+ | Headless architecture, better TypeScript, smaller bundle |
| WebSocket for simple updates | Server-Sent Events | 2020+ | Simpler protocol, auto-reconnect, HTTP-friendly |
| Client-side sorting/filtering | Virtualized + server-side | 2023+ | Handles 100k+ rows without lag |
| ~~DuckDB-WASM in browser~~ | API-first data access | 2024 | Centralized business logic, simpler architecture |
| Formik | React Hook Form | 2020+ | Better performance, less boilerplate, smaller bundle |

**Deprecated/outdated:**
- **Create React App:** No longer maintained, use Vite
- **Redux for everything:** Overkill for server state, use TanStack Query
- **Synchronous React Router:** Use data routers (createBrowserRouter)
- **componentWillMount/WillUpdate:** Use hooks and effects
- **DuckDB-WASM for production apps:** Heavy bundle, complex CORS, prefer API-first for most use cases

## Open Questions

1. **Edit operation atomicity**
   - What we know: Edit creates tombstone + new version via two tool calls
   - What's unclear: Should these be wrapped in a transaction?
   - Recommendation: Implement idempotent edit endpoint that handles both operations atomically

2. **Real-time update granularity**
   - What we know: SSE can push updates to clients
   - What's unclear: Should we push full memory objects or just IDs requiring refetch?
   - Recommendation: Start with "invalidate cache" signals (lightweight), optimize to partial updates if needed

3. **Tree view performance with deep hierarchies**
   - What we know: File-explorer-style trees can become slow with 1000+ nodes
   - What's unclear: DuckBrain key depth and breadth patterns
   - Recommendation: Implement virtualized tree, lazy-load children, add search/filter

4. **Mobile responsive priorities**
   - What we know: Desktop-first for Phase 4 per discretion
   - What's unclear: Which features are essential on mobile vs tablet
   - Recommendation: Tablet gets full three-panel layout, mobile gets stacked views with essential features

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Build + dev | ✓ | 24.8.0 | — |
| npm | Package management | ✓ | 11.6.0 | Use yarn/pnpm |
| Modern browser | React app | ✓ | Chrome/FF/Safari | All modern browsers supported |
| Express | API server | ✓ | (from http.ts) | — |

**Missing dependencies with no fallback:**
- None — all can be npm installed

**Missing dependencies with fallback:**
- None — all core dependencies are well-maintained

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.x |
| Config file | `packages/ui/vitest.config.ts` |
| Quick run command | `npm run test -- --run` |
| Full suite command | `npm run test` |
| Component testing | React Testing Library + happy-dom |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| UI-01 | Tree view renders keys hierarchically | component | `npm test -- tree.test.tsx` | ❌ Wave 0 |
| UI-01 | Timeline table shows memories chronologically | component | `npm test -- timeline.test.tsx` | ❌ Wave 0 |
| UI-02 (REVISED) | API endpoints call MCP tools correctly | integration | `npm test -- api-tools.test.ts` | ❌ Wave 0 |
| UI-03 | Express serves static UI files | integration | `npm test -- http-static.test.ts` | ❌ Wave 0 |
| UI-04 | Memory edit form validates and submits | component | `npm test -- memory-edit.test.tsx` | ❌ Wave 0 |
| UI-04 | Edit creates tombstone + new version | integration | `npm test -- edit-flow.test.ts` | ❌ Wave 0 |
| UI-05 | Namespace selector switches correctly | component | `npm test -- namespace.test.tsx` | ❌ Wave 0 |
| UI-06 | Settings form persists configuration | integration | `npm test -- settings.test.ts` | ❌ Wave 0 |
| UI-07 | SSE receives and handles events | integration | `npm test -- sse.test.ts` | ❌ Wave 0 |
| UI-08 | Responsive layout adapts to screen size | e2e | Playwright | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test -- --run --reporter=verbose`
- **Per wave merge:** `npm run test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/ui/vitest.config.ts` — test framework config
- [ ] `packages/ui/src/test/setup.ts` — test utilities and mocks
- [ ] `packages/ui/src/test/api-mock.ts` — API client mock
- [ ] `packages/ui/src/components/__tests__/` — component tests

## Sources

### Primary (HIGH confidence)
- **TanStack Table v8 Documentation** — API reference, virtualization examples
- **TanStack Query v5 Documentation** — Caching patterns, mutations, optimistic updates
- **React Router v7 Documentation** — Data routers, nested routing
- **MDN Web APIs** — EventSource, WebSocket, Fetch API
- **shadcn/ui Documentation** — Component patterns, Tailwind integration
- **React Hook Form Documentation** — Form validation, integration patterns

### Secondary (MEDIUM confidence)
- **Vite Documentation** — Build configuration, dev server
- **Tailwind CSS Documentation** — Custom theming, dark mode, responsive design
- **React Aria Documentation** — Accessibility patterns (shadcn/ui foundation)
- **Linear App UI Analysis** — Slide-out panels, timeline patterns
- **Zod Documentation** — Schema validation patterns

### Tertiary (LOW confidence)
- **Community examples** — Specific implementations of React Hook Form + TanStack Query
- **Performance benchmarks** — May vary with actual data volumes

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — All libraries are industry standard with excellent documentation
- Architecture: HIGH — Centralized tool pattern proven, API-first is standard approach
- Pitfalls: MEDIUM-HIGH — Based on common React patterns and TanStack community reports
- State of the art: HIGH — Current best practices as of 2026

**Research date:** 2026-04-02
**Valid until:** 2026-07-02 (90 days for stable dependencies, faster-moving ecosystem may need refresh sooner)

---

*Phase 04: Web UI — Research Complete (Updated with Centralized Architecture)*
