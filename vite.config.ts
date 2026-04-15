import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// OpenClaw Gateway 地址
// 本地开发: ws://localhost:18789
// 远程连接: ws://192.168.x.x:18789
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY || 'ws://localhost:18789'

export default defineConfig({
  plugins: [react()],
  base: './',  // 相对路径，支持任意部署位置
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-state': ['zustand'],
          'vendor-ui': ['framer-motion', 'lucide-react'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // WebSocket 代理 - 转发到 OpenClaw Gateway
      '/ws': {
        target: GATEWAY_URL,
        ws: true,
        changeOrigin: true,
      },
      // HTTP API 代理
      '/api': {
        target: GATEWAY_URL.replace('ws://', 'http://').replace('wss://', 'https://'),
        changeOrigin: true,
      },
      // 本地服务代理 - 转发到 ddos-local-server.py
      // 远程访问时浏览器无需直连 3001 端口
      '/local-api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/local-api/, ''),
      },
    },
  },
})
