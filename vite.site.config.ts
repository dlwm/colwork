import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [vue(), react()],
  define: { __COLWORK_CLOUDFLARE__: true },
  build: {
    outDir: 'site-dist',
    rollupOptions: { input: ['index.html', 'test/vue.html', 'test/react.html', 'test/index.html'] },
  },
})
