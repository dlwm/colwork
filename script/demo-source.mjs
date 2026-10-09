import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))
export const npmDemoRoot = resolve(projectRoot, '.wrangler/npm-demo')

export function demoSource(value = process.env.COLWORK_SOURCE ?? 'local') {
  if (value !== 'local' && value !== 'npm') throw new Error('COLWORK_SOURCE / --source must be local or npm')
  return value
}

export function demoAliases() {
  const source = demoSource()
  const entry = source === 'npm'
    ? resolve(npmDemoRoot, 'node_modules/@kuzuma/colwork/dist/colwork.js')
    : resolve(projectRoot, 'src/index.ts')
  const css = source === 'npm'
    ? resolve(npmDemoRoot, 'node_modules/@kuzuma/colwork/dist/colwork.css')
    : resolve(projectRoot, 'src/colwork-table.css')
  if (!existsSync(entry) || !existsSync(css)) throw new Error('Demo package missing. Run npm run dev -- --source=npm to install it.')
  return [
    { find: /^@colwork-demo$/, replacement: entry },
    { find: /^@colwork-demo\/style$/, replacement: css },
  ]
}
