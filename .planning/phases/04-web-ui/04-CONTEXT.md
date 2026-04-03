# Phase 04: Web UI - Context

**Gathered:** 2026-04-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Browser-based interface for memory exploration. File-explorer-style memory tree navigation, timeline view of memories, and search/filtering capabilities. The web UI provides a visual alternative to the CLI for browsing, searching, and exploring stored memories.

This phase does NOT include: memory editing (Phase 5), user management (future), real-time collaboration (future), mobile apps (out of scope).
</domain>

<decisions>
## Implementation Decisions

### UI Architecture
- **D-01:** Embedded Express UI — mount React/Vue app within existing Express server
  - Serve static UI files from Express (src/cli/http.ts already exists)
  - API endpoints under `/api/*` for data operations
  - UI routes handled by SPA router (React Router or similar)
- **D-02:** Single-page application (SPA) with client-side routing
  - Fast navigation between tree view, timeline, search
  - No page reloads when switching views
  - URL-based state for shareable/bookmarkable views
- **D-03:** Hybrid rendering — initial HTML from server, then client hydration
  - Fast first paint with server-rendered HTML
  - Interactive after JavaScript loads
  - Fallback to server rendering if JS fails

### Technology Stack
- **D-04:** React with TypeScript for UI framework
  - Consistent with project's TypeScript codebase
  - Large ecosystem, well-documented
  - Component-based architecture for tree/timeline/search views
- **D-05:** DuckDB-WASM for in-browser querying
  - Query memories directly in browser without API calls
  - Leverages existing DuckDB infrastructure
  - Full SQL power for complex filtering/sorting
- **D-06:** Tailwind CSS for styling (if needed)
  - Utility-first, minimal custom CSS
  - Can be added incrementally
  - If not: vanilla CSS with CSS variables for theming
- **D-07:** Vite for build tooling
  - Fast dev server with HMR
  - Optimized production builds
  - TypeScript support out of the box

### Memory Tree Navigation
- **D-08:** File-explorer-style tree view with collapsible folders
  - Hierarchical display of `/projects/mcp/schema` style keys
  - Expand/collapse nodes with click or arrow keys
  - Visual indicators for domains (colors/icons)
- **D-09:** Lazy loading for large trees
  - Load children on demand when folder expands
  - Virtual scrolling for very long lists
  - Show item counts per folder
- **D-10:** Click key path to view memory details
  - Panel-based layout: tree on left, details on right
  - Show memory attributes, timestamp, author
  - JSON viewer for complex attributes

### Timeline View
- **D-11:** Chronological feed with time grouping
  - Group by date (Today, Yesterday, Last Week, etc.)
  - Scrollable infinite list (load more on scroll)
  - Visual timeline markers
- **D-12:** Filter by domain, author, date range
  - Dropdown filters in toolbar
  - Combined filters (AND logic)
  - Quick filters for common queries
- **D-13:** Click timeline item to view full memory
  - Modal or slide-in panel for details
  - Show full JSON with syntax highlighting
  - Link to tree view location

### Search & Filtering
- **D-14:** Real-time search with debouncing
  - Search as you type (300ms debounce)
  - Search across keys, domains, attributes
  - Highlight matching terms
- **D-15:** Advanced search syntax (optional)
  - `domain:person` for domain filter
  - `author:alice` for author filter
  - `key:/projects/*` for key prefix
- **D-16:** Empty state with suggestions
  - "No memories found" with helpful tips
  - Suggest popular/nearby keys
  - Link to documentation

### Data Access Patterns
- **D-17:** DuckDB-WASM loads JSONL files directly
  - Browser accesses memory files via HTTP range requests
  - No API server needed for queries (client-side DuckDB)
  - Caching layer for frequently accessed partitions
- **D-18:** HTTP API for writes (remember, forget)
  - POST `/api/remember` — add new memory
  - POST `/api/forget` — tombstone memory
  - Reuse existing MCP tool implementations

### Visual Design & Aesthetic
- **D-19:** "Architectural Cybernetics" theme — clinical lab meets cyberpunk
  - Dark mode only (no light theme for Phase 4)
  - Glassmorphism panels with subtle transparency and blur
  - Glowing accent colors (azure, amber) against dark backgrounds
- **D-20:** Specific color palette locked
  - Background: Midnight Slate (`#0B101E`)
  - Primary accent: Hologram Azure (`#00D4FF`) — links, active states, icons
  - Secondary accent: Neural Amber (`#FFB020`) — warnings, CTAs, highlights
  - Text: Pristine white (`#F8FAFC`) for primary, Clinical gray (`#94A3B8`) for secondary
  - Glass surfaces: `rgba(255,255,255,0.03)` background, `rgba(255,255,255,0.08)` borders
  - Success: Neon green (`#00FF66`) for active/online indicators
- **D-21:** Typography system
  - UI text: Inter (weights 400, 500, 600, 700)
  - Data/monospace: JetBrains Mono (weights 400, 500) — for keys, JSON, timestamps
  - Google Fonts CDN for loading
- **D-22:** Glassmorphism component system
  - Panels: `backdrop-filter: blur(16px)`, gradient overlay, 1px border
  - Hover states: subtle brightness increase (`rgba(255,255,255,0.06)`)
  - Active states: inner shadow with azure glow
  - Shadows: Neon glows for accents (`0 0 12px rgba(0,212,255,0.3)`)
- **D-23:** Lucide icons throughout
  - Consistent 16px-24px sizing
  - Color-matched to context (azure for active, amber for warnings, clinical for inactive)

### Layout Structure (Three-Panel)
- **D-24:** Left sidebar (256px) — Archive Navigation
  - Fixed width, collapsible on mobile
  - Sections: Namespaces (with status dots), Memory Tree (file-explorer style)
  - Bottom: System Config button
  - Scrollbar: Thin (6px), transparent track, subtle white thumb
- **D-25:** Main stage (flexible) — Operating Table
  - Top: Omnibar search (centered, rounded-full, Cmd+K shortcut)
  - Vitals widgets row: Active Memories, Git Batch Queue, Tombstone Ratio
  - Content: Timeline feed or Tree view (switchable)
- **D-26:** Right inspector (450px, slide-out) — The Microscope
  - Slides in from right over main content
  - Header: Memory Inspector title with close button
  - Content: Memory details grid + JSON payload viewer
  - Footer: Copy JSON + Forget buttons
  - Glass panel with left border accent

### Components & Interactions
- **D-27:** Memory Tree navigation
  - Collapsible folders with chevron indicators
  - Nested items indented with left border line
  - Active folder: subtle inner glow, border highlight
  - Icons: `folder`/`folder-open` for containers, `file-json` for memories
- **D-28:** Timeline table (The Grid)
  - Columns: State (dot), Key Path (mono), Domain (badge), Action (badge), Timestamp (mono)
  - Tombstone rows: 40% opacity, strikethrough key
  - Hover: Row highlight with glass effect
  - Click row: Opens inspector panel
- **D-29:** Vitals widgets
  - Three-card grid above table
  - Glass panel with rounded-xl corners
  - Large numeric values with trend indicators
  - Progress bar for Git Batch (azure fill)
  - Interactive: Tombstone Ratio card has "Squash & Compact" CTA
- **D-30:** Memory Inspector (slide-out)
  - Fixed width 450px, full height
  - Form-like layout: Label (uppercase, tracking-widest) + Value
  - JSON viewer: Darker background (`#060913`), syntax highlighted
    - Keys: Azure (`#00D4FF`)
    - Strings: Amber (`#FFB020`)
    - Numbers: Purple (`#A78BFA`)
    - Booleans: Green (`#34D399`)
    - Null: Red (`#FB7185`)
- **D-31:** Search Omnibar
  - Centered in header, max-width 2xl
  - Rounded-full input with glass panel
  - Search icon (clinical, turns azure on focus)
  - Placeholder: "Cmd+K to search keys, glob patterns, or semantic vectors..."
  - Shortcut badge (⌘K) on right
  - Focus ring: Azure glow shadow

### Animations & Transitions
- **D-32:** Smooth, purposeful motion
  - Inspector slide: 300ms ease-in-out transform
  - Hover states: 150ms color/background transitions
  - Row selection: Instant for responsiveness
  - Loading states: Subtle pulse on skeleton elements

### the agent's Discretion
- Exact timing curves for animations (easing functions)
- Responsive breakpoints for mobile/tablet (desktop-first for Phase 4)
- Error boundary fallback UI design
- Service worker for offline capability (optional enhancement)
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### UI Requirements
- `.planning/ROADMAP.md` lines 83-97 — Phase 4 goal and success criteria
- `.planning/PROJECT.md` lines 37 — UI-01 requirement (Web interface)

### HTTP Server (existing)
- `src/cli/http.ts` — Express server with health endpoints, DNS rebinding protection
- `.planning/phases/03-multi-user-remote/03-CONTEXT.md` lines 67-75 — HTTP auth and rate limiting decisions

### Storage & Query Patterns
- `src/storage/jsonl.ts` — JSONL partition handling
- `src/duckdb/queries.ts` — Query patterns for memories
- `.planning/phases/01-core-mvp/01-CONTEXT.md` lines 15-25 — Storage decisions

### Prior Phase Context
- `.planning/phases/03-multi-user-remote/03-CONTEXT.md` lines 202-206 — Web UI deferred to Phase 4
- `.planning/phases/02-git-automation/02-CONTEXT.md` — Namespace and memory structure

### Technical Stack
- `.planning/codebase/STACK.md` — Technology stack (Node.js, TypeScript, Express)
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/cli/http.ts:createHttpServer()` — Express server factory (add static file serving)
- `src/mcp/tools/list_keys.ts` — Key tree traversal logic
- `src/mcp/tools/recall.ts` — Memory query patterns
- `src/duckdb/queries.ts` — SQL queries (adapt for DuckDB-WASM)
- `src/schema/memory.ts` — Memory structure definitions

### Established Patterns
- **Express Pattern:** Middleware stack in src/cli/http.ts (DNS rebinding, auth, JSON parsing)
- **Tool Pattern:** MCP tools in src/mcp/tools/ handle domain logic — reuse for API endpoints
- **Config Pattern:** JSON-based configuration in ~/.duckbrain/config.json
- **Namespace Pattern:** Namespaces as separate git repos under namespaces/

### Integration Points
- **Express Integration:** Add static middleware to existing Express app in src/cli/http.ts
- **API Integration:** New `/api/*` routes alongside existing `/health`, `/mcp` endpoints
- **Build Integration:** Vite build outputs to dist/, served by Express in production
- **Data Integration:** DuckDB-WASM loads from namespaces/{name}/**/*.jsonl files
</code_context>

<specifics>
## Specific Ideas

### Layout Concept
```
┌─────────────────────────────────────────────────────────────┐
│ DuckBrain Web UI                    [Search] [Filters] [⚙️] │
├──────────────┬──────────────────────────────────────────────┤
│ 📁 Memories  │  Timeline View — Last 7 Days                  │
│ 📁 /projects │                                               │
│   📁 mcp     │  [icon] 2 hours ago — /projects/mcp/schema  │
│     📄 api   │      domain: concept | author: alice         │
│ 📁 /people   │      "MCP schema design with DuckDB..."       │
│   📄 alice   │                                               │
│   📄 bob     │  [icon] Yesterday — /people/alice             │
│ 📁 /concepts │      domain: person | author: bob              │
│              │      "Alice is an engineer working..."         │
├──────────────┴──────────────────────────────────────────────┤
│ Status: 1,234 memories | Namespace: default | Online ✓     │
└─────────────────────────────────────────────────────────────┘
```

### HTML/CSS Prototype Reference
User provided working HTML/CSS prototype demonstrating exact aesthetic. Key elements:

**Color Variables (Tailwind config):**
```javascript
colors: {
  midnight: '#0B101E',
  glass: 'rgba(255, 255, 255, 0.03)',
  glassHover: 'rgba(255, 255, 255, 0.06)',
  glassBorder: 'rgba(255, 255, 255, 0.08)',
  amber: '#FFB020',
  azure: '#00D4FF',
  pristine: '#F8FAFC',
  clinical: '#94A3B8',
  success: '#00FF66'
}
```

**Shadows:**
- `neon-azure`: `0 0 12px rgba(0, 212, 255, 0.3)`
- `neon-amber`: `0 0 12px rgba(255, 176, 32, 0.3)`
- `inner-azure`: `inset 0 0 12px rgba(0, 212, 255, 0.05)`

**Typography Classes:**
- Labels: `text-[10px] font-bold text-clinical uppercase tracking-widest`
- Data: `font-mono text-sm`
- Headings: `text-lg font-semibold text-pristine`

**Key Component Classes:**
- Panel: `glass-panel rounded-xl` (gradient + blur + border)
- Button primary: `bg-glass border border-glassBorder hover:bg-glassHover`
- Button CTA: `hover:border-amber/50 hover:text-amber`
- Active state: `bg-glassHover border border-glassBorder shadow-inner-azure`
- Status dot active: `bg-success shadow-[0_0_8px_rgba(0,255,102,0.6)]`

### URL Structure
- `/` — Tree view (root)
- `/tree/:path` — Tree view at specific key
- `/timeline` — Timeline view
- `/search?q=term` — Search results

### DuckDB-WASM Query Example
```typescript
// Load DuckDB-WASM in browser
const db = await duckdbWasm.createDb();
await db.registerFileURL('memories.jsonl', '/api/files/default/raw_note/2026/current.jsonl');

// Query in browser
const result = await db.query(`
  SELECT * FROM read_json('memories.jsonl')
  WHERE key LIKE '/projects/%'
  ORDER BY timestamp DESC
  LIMIT 50
`);
```

### Express Static Serving
```typescript
// In src/cli/http.ts
if (process.env.NODE_ENV === 'production') {
  app.use(express.static('dist'));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}
```

</specifics>

<deferred>
## Deferred Ideas

### Out of Scope for Phase 4
- **Memory Editing** — Inline editing of memories (Phase 5)
- **Real-time Collaboration** — Multiple users editing simultaneously (future)
- **Visual Graph View** — Force-directed graph of memory relationships (future)
- **Mobile App** — Native iOS/Android apps (out of scope per PROJECT.md)
- **Theming/Customization** — User-defined themes, dark mode (could be Phase 4.x)
- **Offline Support** — Service worker, local storage sync (enhancement)
- **Import/Export UI** — Visual import from other tools (future)
- **Admin Dashboard** — System metrics, user management (enterprise future)

### Future Enhancements
- **Keyboard Shortcuts** — Vim-style navigation, quick commands
- **Bookmarking** — Save frequently accessed paths
- **Recent Views** — Recently accessed memories panel
- **Sharing** — Generate shareable links to specific memories
- **Annotations** — Add comments to memories (not editing, just notes)
- **Diff View** — Compare memory versions over time

</deferred>

---

*Phase: 04-web-ui*
*Context gathered: 2026-04-02*
