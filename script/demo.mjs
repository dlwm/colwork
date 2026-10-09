import { spawn } from 'node:child_process'
import { demoSource, npmDemoRoot, projectRoot } from './demo-source.mjs'

const [command, ...args] = process.argv.slice(2)
const forwarded = []
let source = process.env.COLWORK_SOURCE ?? 'local'
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--source') source = args[++index]
  else if (args[index].startsWith('--source=')) source = args[index].slice('--source='.length)
  else forwarded.push(args[index])
}
if (command !== 'dev' && command !== 'build') throw new Error('Expected demo command: dev or build')
if (source === undefined) throw new Error('--source requires local or npm')
source = demoSource(source)
const env = { ...process.env, COLWORK_SOURCE: source }
let child
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal))

async function run(executable, parameters) {
  const status = await new Promise((resolve, reject) => {
    child = spawn(executable, parameters, { cwd: projectRoot, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)))
  })
  if (status !== 0) process.exit(status)
}

if (source === 'npm') {
  const version = process.env.COLWORK_NPM_VERSION ?? '0.1.0'
  console.log(`Colwork demo source: @kuzuma/colwork@${version}`)
  await run('npm', ['install', '--prefix', npmDemoRoot, '--no-save', '--package-lock=false', '--ignore-scripts', '--registry=https://registry.npmjs.org', `@kuzuma/colwork@${version}`])
} else console.log('Colwork demo source: local src/')

if (command === 'dev') await run(process.execPath, ['server/index.mjs', '--mode', 'test', ...forwarded])
else {
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'])
  await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.site.config.ts', ...forwarded])
}
