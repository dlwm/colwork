import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { writeFile } from 'node:fs/promises'

export default defineConfig({
  plugins: [dts({
    tsconfigPath: './tsconfig.lib.json', entryRoot: 'src',
    include: ['src/model*.ts', 'src/range.ts', 'src/yjsArchive.ts', 'src/yjsRebuild.ts'],
    beforeWriteFile(filePath, content) {
      return { filePath, content: content.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g, '$1$2.js$3') }
    },
    async afterBuild(files) {
      for (const [filePath, content] of files) {
        if (!filePath.endsWith('.d.ts')) continue
        const commonJS = content.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)\.js(['"])/g, '$1$2.cjs$3')
        await writeFile(filePath.replace(/\.d\.ts$/, '.d.cts'), commonJS)
      }
    },
  })],
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/model.ts',
      fileName: format => format === 'es' ? 'model.js' : 'model.cjs',
      formats: ['es', 'cjs'],
    },
    rollupOptions: { external: ['yjs'] },
  },
})
