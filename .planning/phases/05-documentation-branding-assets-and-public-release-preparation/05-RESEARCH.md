# Phase 5: Documentation, Branding & Public Release Research

## Executive Summary

This research covers tooling and best practices for DuckBrain's public release phase. We need: logo/mascot generation, screenshot automation, documentation site, README optimization, and brand asset management. The stack is Vite + React + TypeScript + Tailwind CSS.

---

## Standard Stack (Recommended Tools)

### 1. Logo & Mascot Generation

**Primary Recommendation: Use DALL-E 3 via ChatGPT Plus ($20/mo) or Bing Image Creator (free)**

| Tool | Best For | Cost (2025) | Vector Export | Confidence |
|------|----------|-------------|---------------|------------|
| **DALL-E 3** | Logo concepts, precise prompt adherence | Free via Bing / $20/mo | No* | HIGH |
| **Midjourney V7** | Artistic quality, mood, cinematic | $10-120/mo | No* | MEDIUM |
| **Adobe Firefly** | Commercial-safe, brand assets | $9.99/mo+ | Partial | MEDIUM |
| **Recraft V4** | Vector logos, SVG export | $10/mo+ | **Yes** | HIGH |
| **Ideogram** | Text-heavy images, memes | $8/mo | No | LOW |

\*Midjourney and DALL-E export raster PNG/JPEG only. For vector logos, use Recraft (native SVG export) or trace in Illustrator/Figma after generation.

**DuckBrain Decision:**
1. **Use Recraft V4** for the logo (existing prompts in `design/prompts/logo.md` can be adapted)
2. **Use DALL-E 3** for mascot character art (cyberpunk lab setting in `design/prompts/mascot.md`)
3. **Post-processing:** Import to Figma/Illustrator for vectorization and cleanup

### 2. Screenshot Automation

**Use Playwright — Microsoft-backed, first-class Vite/React support**

```bash
npm install -D @playwright/test
npx playwright install
```

**Why Playwright over Puppeteer/Selenium:**
- Native React/Vite support
- Built-in screenshot API (`page.screenshot()`)
- Full-page, element, and viewport capture
- Mobile viewport emulation
- Trace viewer for debugging

**Alternative: Chrome DevTools Protocol (CDP)**
- Lower level, more control
- Use only if Playwright limitations are hit
- Requires `chrome-remote-interface` package

### 3. Documentation Site

**Use VitePress — Native Vite integration, perfect fit**

| Tool | Framework | Vite Native | Best For | Setup Complexity |
|------|-----------|-------------|----------|------------------|
| **VitePress** | Vue | **Yes** | Library docs, minimal config | LOW |
| Docusaurus | React | No | Versioned docs, i18n, blog | MEDIUM |
| Nextra | Next.js | No | Next.js ecosystem | MEDIUM |
| Starlight | Astro | No | Performance-first, Lighthouse 100 | LOW |
| MkDocs | Python | No | Python projects | LOW |

**VitePress Advantages for DuckBrain:**
- Same Vite build tooling as UI package
- Zero-config local search (no Algolia key needed)
- Markdown + Vue components
- Fastest HMR (hot module replacement)
- Used by Vue, Vite, Rollup teams

**VitePress Configuration Example:**
```typescript
// docs/.vitepress/config.ts
import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'DuckBrain',
  description: 'AI Memory System with Git-versioned persistence',
  
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/mcp-tools' },
      { text: 'GitHub', link: 'https://github.com/wojons/duckbrain' }
    ],
    
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is DuckBrain?', link: '/guide/what-is' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Architecture', link: '/guide/architecture' }
          ]
        },
        {
          text: 'Core Concepts',
          items: [
            { text: 'Memory Model', link: '/guide/memory-model' },
            { text: 'Git Integration', link: '/guide/git-integration' },
            { text: 'Namespaces', link: '/guide/namespaces' }
          ]
        }
      ],
      '/api/': [
        {
          text: 'MCP Tools',
          items: [
            { text: 'remember()', link: '/api/remember' },
            { text: 'recall()', link: '/api/recall' },
            { text: 'list_keys()', link: '/api/list-keys' },
            { text: 'forget()', link: '/api/forget' }
          ]
        }
      ]
    },
    
    search: {
      provider: 'local'  // Free, no API key
    },
    
    socialLinks: [
      { icon: 'github', link: 'https://github.com/wojons/duckbrain' }
    ]
  }
})
```

### 4. README Best Practices (2025)

**Structure Template:**

```markdown
# DuckBrain ![Logo](assets/logo-32.png)

[![Tests](https://img.shields.io/github/workflow/status/wojons/duckbrain/test)](link)
[![License](https://img.shields.io/github/license/wojons/duckbrain)](link)
[![npm](https://img.shields.io/npm/v/duckbrain)](link)

> One-line description: AI Memory System with Git-versioned persistence

## What is DuckBrain?

2-3 sentences explaining the problem and solution.

## Features

- Feature 1
- Feature 2
- Feature 3

## Quick Start

\`\`\`bash
npm install duckbrain
npx duckbrain init
\`\`\`

## Documentation

Full docs at [duckbrain.dev](https://duckbrain.dev)

## Screenshots

![Tree View](docs/assets/screenshot-tree.png)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)
```

**Badge Recommendations:**
- Use [shields.io](https://shields.io) for all badges
- Minimum badges: build status, license, npm version
- Optional: downloads, GitHub stars, Discord invite

**Social Preview Image:**
- Dimensions: 1280×640px (640×320px minimum)
- Format: PNG, JPG, or GIF under 1MB
- Set via GitHub repo Settings → Social preview

### 5. Brand Asset Management

**Repository Structure:**

```
assets/
├── brand/
│   ├── logo/
│   │   ├── logo.svg           # Master vector
│   │   ├── logo.png           # 512x512 export
│   │   ├── logo-128.png       # Favicon size
│   │   └── logo-dark.svg      # Dark mode variant
│   ├── mascot/
│   │   ├── mascot.png         # Full character
│   │   ├── mascot-avatar.png  # Circular crop
│   │   └── mascot.svg         # Vector if available
│   └── social/
│       ├── social-preview.png # 1280x640 GitHub
│       ├── twitter-card.png   # 1200x600
│       └── og-image.png       # 1200x630
└── screenshots/
    ├── tree-view.png
    ├── timeline-view.png
    └── inspector-panel.png
```

**Storage Strategy:**
1. **Primary:** Store in repo under `assets/` (version controlled)
2. **GitHub:** Use repo's social preview feature
3. **README:** Reference relative paths from repo root
4. **Avoid:** External CDNs (imgur, etc.) — link rot risk

---

## Architecture Patterns

### Screenshot Automation Script

Create `scripts/capture-screenshots.ts`:

```typescript
import { chromium } from '@playwright/test'

async function captureScreenshots() {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()
  
  // Start dev server first: npm run dev
  await page.goto('http://localhost:5173')
  
  // Wait for app to load
  await page.waitForSelector('[data-testid="memory-tree"]')
  
  // Tree view screenshot
  await page.screenshot({
    path: 'assets/screenshots/tree-view.png',
    fullPage: false
  })
  
  // Navigate to timeline
  await page.click('[data-testid="timeline-tab"]')
  await page.waitForTimeout(500) // Wait for animation
  
  await page.screenshot({
    path: 'assets/screenshots/timeline-view.png',
    fullPage: false
  })
  
  await browser.close()
}

captureScreenshots().catch(console.error)
```

### Documentation Site Structure

```
docs/
├── .vitepress/
│   ├── config.ts
│   └── theme/
│       └── custom.css
├── guide/
│   ├── what-is.md
│   ├── getting-started.md
│   ├── architecture.md
│   ├── memory-model.md
│   ├── git-integration.md
│   └── namespaces.md
├── api/
│   ├── remember.md
│   ├── recall.md
│   ├── list-keys.md
│   └── forget.md
├── public/
│   └── logo.svg
└── package.json
```

### Logo Generation Pipeline

1. **Generate concepts** with Recraft V4 using `design/prompts/logo.md`
2. **Export SVG** from Recraft (native support)
3. **Refine in Figma**: Cleanup paths, verify geometry
4. **Export variants**: SVG master, PNG @1x @2x @3x, dark mode
5. **Store in** `assets/brand/logo/`

### Mascot Generation Pipeline

1. **Generate character** with DALL-E 3 using `design/prompts/mascot.md`
2. **Upscale** with Gigapixel AI or similar (optional)
3. **Remove background** with Remove.bg or Photoshop
4. **Create variants**: Full body, avatar crop, action poses
5. **Store in** `assets/brand/mascot/`

---

## Don't Hand-Roll

| Use Existing Tool | Don't Build |
|-------------------|-------------|
| VitePress / Docusaurus | Custom docs site generator |
| Playwright | Custom screenshot script with Puppeteer |
| shields.io | Custom badge generation |
| Recraft/DALL-E 3 | Custom AI image model training |
| GitHub social preview | Custom OpenGraph generator |
| PageFind / Algolia | Custom search indexing |

---

## Common Pitfalls

### Logo Generation

**❌ Don't:**
- Expect Midjourney/DALL-E to output true SVG (they output raster)
- Use text-heavy logos (AI struggles with legible text)
- Skip manual refinement — AI generates concepts, not final assets

**✅ Do:**
- Use Recraft for native SVG export
- Generate multiple concepts, curate manually
- Test logo at 32×32 (favicon) and 512×512 (app icon)

### Screenshots

**❌ Don't:**
- Capture screenshots manually (inconsistent sizing, out of date)
- Store screenshots in `/docs` if they're large (keep repo size down)
- Use screenshots with sensitive data

**✅ Do:**
- Automate with Playwright in CI
- Use mock data for demo screenshots
- Size consistently: 1440×900 for desktop, 375×812 for mobile

### Documentation

**❌ Don't:**
- Write docs in repo README (gets too long)
- Use complex frameworks when VitePress suffices
- Forget mobile viewport testing

**✅ Do:**
- Keep README < 100 lines, link to full docs
- Test docs site on mobile (60%+ devs read on phone)
- Version docs if API changes frequently

### README

**❌ Don't:**
- Skip badges — they're credibility signals
- Use GIFs > 5MB (GitHub loads slowly)
- Put installation 500 lines down

**✅ Do:**
- Lead with one-line description
- Put Quick Start in first 50 lines
- Use collapsible sections for long content

---

## Code Examples

### Playwright Screenshot Script

```typescript
// scripts/capture-screenshots.ts
import { chromium, FullConfig } from '@playwright/test'

interface ScreenshotConfig {
  name: string
  path: string
  viewport?: { width: number; height: number }
  fullPage?: boolean
  selector?: string
}

const screenshots: ScreenshotConfig[] = [
  {
    name: 'tree-view',
    path: 'assets/screenshots/tree-view.png',
    viewport: { width: 1440, height: 900 }
  },
  {
    name: 'timeline-view',
    path: 'assets/screenshots/timeline-view.png',
    viewport: { width: 1440, height: 900 }
  },
  {
    name: 'inspector-panel',
    path: 'assets/screenshots/inspector-panel.png',
    selector: '[data-testid="inspector-panel"]'
  }
]

async function captureScreenshots() {
  const browser = await chromium.launch({ headless: true })
  
  for (const config of screenshots) {
    const context = await browser.newContext({
      viewport: config.viewport || { width: 1440, height: 900 }
    })
    const page = await context.newPage()
    
    await page.goto('http://localhost:5173')
    await page.waitForLoadState('networkidle')
    
    if (config.selector) {
      const element = await page.locator(config.selector)
      await element.screenshot({ path: config.path })
    } else {
      await page.screenshot({
        path: config.path,
        fullPage: config.fullPage ?? false
      })
    }
    
    await context.close()
  }
  
  await browser.close()
  console.log(`✓ Captured ${screenshots.length} screenshots`)
}

captureScreenshots().catch(err => {
  console.error('Screenshot failed:', err)
  process.exit(1)
})
```

### VitePress Documentation Setup

```bash
# Initialize docs
mkdir docs
cd docs
npm init -y
npm install -D vitepress

# Initialize VitePress
npx vitepress init

# Start dev server
npx vitepress dev

# Build for production
npx vitepress build
```

### README Badges

```markdown
[![Tests](https://img.shields.io/github/actions/workflow/status/wojons/duckbrain/test.yml?branch=main&label=tests)](https://github.com/wojons/duckbrain/actions)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![npm version](https://img.shields.io/npm/v/duckbrain)](https://www.npmjs.com/package/duckbrain)
[![Downloads](https://img.shields.io/npm/dm/duckbrain)](https://www.npmjs.com/package/duckbrain)
[![GitHub stars](https://img.shields.io/github/stars/wojons/duckbrain?style=social)](https://github.com/wojons/duckbrain)
```

### GitHub Social Preview

```bash
# Create social preview image (1280x640)
# Use Figma, Canva, or generate from logo + text

# Upload via GitHub API or Settings UI
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @assets/brand/social/social-preview.png \
  "https://api.github.com/repos/wojons/duckbrain/contents/assets/brand/social/social-preview.png"
```

---

## Confidence Levels

| Decision | Tool | Confidence | Rationale |
|----------|------|------------|-----------|
| Logo Generation | Recraft V4 | **HIGH** | Native SVG export, best for vector logos |
| Mascot Generation | DALL-E 3 | **HIGH** | Superior prompt adherence for complex scenes |
| Screenshot Automation | Playwright | **HIGH** | Best Vite/React support, mature API |
| Documentation Site | VitePress | **HIGH** | Native Vite, zero-config search, perfect fit |
| README Structure | shields.io template | **HIGH** | Established convention, widely adopted |
| Asset Storage | Git repo `assets/` | **HIGH** | Version control, no external dependencies |

---

## Summary

**Phase 5 Tooling Stack:**

1. **Logo:** Recraft V4 → Figma refinement → SVG/PNG exports
2. **Mascot:** DALL-E 3 (Bing free or ChatGPT Plus) → Background removal
3. **Screenshots:** Playwright automated capture from running dev server
4. **Documentation:** VitePress with local search, deployed to GitHub Pages
5. **README:** shields.io badges, concise structure, link to docs site
6. **Assets:** Version controlled in `assets/` directory

**Files to Create:**
- `docs/` — VitePress documentation site
- `assets/brand/logo/` — Logo variants
- `assets/brand/mascot/` — Mascot images
- `assets/screenshots/` — UI screenshots
- `scripts/capture-screenshots.ts` — Screenshot automation
- Root `README.md` — Refreshed with badges and structure

**Estimated Time:**
- Logo generation: 2-3 hours (iterative refinement)
- Mascot generation: 2-3 hours (concept to final)
- Screenshot automation: 1 hour (Playwright setup)
- Documentation site: 4-6 hours (content migration)
- README refresh: 1 hour
- **Total:** 10-14 hours

---

*Research Date: 2025-04-03*
*Sources: G2 comparison (Aug 2025), PkgPulse framework analysis (Mar 2026), DEV Community tools review (Jul 2025), GitHub Docs*
