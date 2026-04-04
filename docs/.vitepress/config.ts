import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "DuckBrain",
  description: "AI Memory System with Git-versioned persistence",
  base: '/duckbrain/',
  
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/mcp-tools' }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation', link: '/guide/getting-started' },
            { text: 'Quick Start', link: '/guide/quick-start' },
            { text: 'Configuration', link: '/guide/configuration' }
          ]
        },
        {
          text: 'AI Agent Setup',
          items: [
            { text: 'Overview', link: '/guide/ai-configure' },
            { text: 'Claude Desktop', link: '/guide/claude' },
            { text: 'Cursor', link: '/guide/cursor' },
            { text: 'Other Agents', link: '/guide/other-agents' }
          ]
        },
        {
          text: 'Deployment',
          items: [
            { text: 'Docker', link: '/guide/docker' },
            { text: 'Production', link: '/guide/production' }
          ]
        },
        {
          text: 'Reference',
          items: [
            { text: 'Memory Keys', link: '/guide/memory-keys' },
            { text: 'Domains', link: '/guide/domains' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
            { text: 'License', link: '/guide/license' }
          ]
        }
      ],
      '/api/': [
        {
          text: 'MCP Tools',
          items: [
            { text: 'Overview', link: '/api/mcp-tools' },
            { text: 'remember()', link: '/api/remember' },
            { text: 'recall()', link: '/api/recall' },
            { text: 'list_keys()', link: '/api/list-keys' },
            { text: 'forget()', link: '/api/forget' }
          ]
        },
        {
          text: 'HTTP API',
          items: [
            { text: 'Overview', link: '/api/http-api' },
            { text: 'Namespaces', link: '/api/namespaces' },
            { text: 'Memories', link: '/api/memories' },
            { text: 'Authentication', link: '/api/auth' }
          ]
        },
        {
          text: 'CLI',
          items: [
            { text: 'Commands', link: '/api/cli' },
            { text: 'Environment Variables', link: '/api/env-vars' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/wojons/duckbrain' }
    ],

    footer: {
      message: 'Released under the Apache License 2.0',
      copyright: 'Copyright © 2026 DuckBrain Contributors'
    },

    search: {
      provider: 'local'
    }
  }
})
