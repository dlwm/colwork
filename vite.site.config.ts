import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import react from '@vitejs/plugin-react'
import { demoAliases } from './script/demo-source.mjs'

export default defineConfig({
  plugins: [vue(), react()],
  resolve: { alias: demoAliases() },
  define: { __COLWORK_CLOUDFLARE__: true },
  build: {
    outDir: 'site-dist',
    rollupOptions: { input: ['index.html', 'test/vue.html', 'test/react.html', 'test/index.html'] },
  },
})
