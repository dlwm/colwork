import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'Colwork',
      fileName: 'colwork',
      formats: ['es', 'umd'],
    },
  },
})
