import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Configurable ports via environment variables
const UI_PORT = parseInt(process.env.DUCKBRAIN_UI_PORT || '8989')
const API_PORT = parseInt(process.env.DUCKBRAIN_API_PORT || '8490')
const API_HOST = process.env.DUCKBRAIN_API_HOST || 'localhost'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: UI_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://${API_HOST}:${API_PORT}`,
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
