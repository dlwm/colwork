import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.lib.json', rollupTypes: true })],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'Colwork',
      fileName: 'colwork',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['yjs', 'y-protocols/awareness', 'y-webrtc', 'y-websocket'],
      output: {
        globals: {
          yjs: 'Y',
          'y-protocols/awareness': 'YAwareness',
          'y-webrtc': 'YWebrtc',
          'y-websocket': 'YWebsocket',
        },
      },
    },
  },
})
