import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { resolve, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function runCommand(command, args, { cwd, env, capture = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data; if (!capture) process.stdout.write(data) })
    child.stderr.on('data', data => { stderr += data; if (!capture) process.stderr.write(data) })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

async function retryCheck(label, check) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    try { await check(); console.log(`Verified ${label}`); return } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`Published, but verification failed: ${label}. Check DNS, domain activation and Worker logs; do not delete the backend or its storage.`)
}

export async function verifyDeployment(urls) {
  for (const kind of ['backend', 'frontend']) {
    const base = urls[kind]
    if (!base) throw new Error(`Published, but no ${kind} URL was found for verification`)
    await retryCheck(`${kind} HTTP ${base}/health`, async () => {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(7000) })
      if (!response.ok || (await response.json()).service !== 'colwork-backend') throw new Error('Health check failed')
    })
  }
  await retryCheck(`frontend assets ${urls.frontend}`, async () => {
    const response = await fetch(urls.frontend, { signal: AbortSignal.timeout(7000) })
    if (!response.ok || !/\/assets\/.*\.js/.test(await response.text())) throw new Error('Site check failed')
  })
  await retryCheck('frontend WSS collaboration', () => new Promise((resolve, reject) => {
    // Read the initial handshake without sending edits or creating a test room.
    const socket = new WebSocket(urls.frontend.replace(/^http/, 'ws') + '/rooms/colwork-demo', { handshakeTimeout: 7000 })
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket timeout')) }, 7000)
    socket.once('message', (data, binary) => {
      clearTimeout(timer)
      socket.close()
      if (binary && data.length > 1 && data[0] === 0) resolve()
      else reject(new Error('Invalid Yjs handshake'))
    })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
    socket.once('close', () => { clearTimeout(timer); reject(new Error('Socket closed before handshake')) })
  }))
}

export async function deploy({ root = projectRoot, environment = process.env, args = process.argv.slice(2), run = runCommand, verify = verifyDeployment } = {}) {
  if (args.includes('--help')) {
    console.log('npm run deploy [-- --dry-run | --no-login]')
    console.log('Local deploy opens OAuth if needed. CI/--no-login requires existing credentials.')
    return
  }
  if (args.some(arg => !['--dry-run', '--no-login'].includes(arg))) throw new Error('Unknown deployment argument; use --help')
  const dryRun = args.includes('--dry-run')
  const envFile = resolve(root, environment.CF_DEPLOY_CONFIG ?? 'config/cloudflare/deploy.env')
  const localPath = relative(root, envFile)
  const inProject = !localPath.startsWith('..') && !isAbsolute(localPath)
  const gitOptions = { cwd: root, env: environment, capture: true }
  const repository = await run('git', ['rev-parse', '--is-inside-work-tree'], gitOptions)
  if (repository.status === 0) {
    const privatePaths = ['.wrangler', 'site-dist', 'site-dist*.zip', 'build/workers', 'config/cloudflare/*.env', '.env', '.env.*', '.dev.vars', '.dev.vars.*']
    if (inProject) privatePaths.push(localPath)
    const tracked = await run('git', ['ls-files', '--', ...privatePaths], gitOptions)
    const files = tracked.stdout.trim().split('\n').filter(file => file && !file.endsWith('.example'))
    if (tracked.status !== 0 || files.length) throw new Error(`Deployment stopped: local configuration or artifacts are tracked by Git${files.length ? ': ' + files.join(', ') : ''}. Remove them from the Git index first; keep local files.`)
    if (inProject && (await run('git', ['check-ignore', '--quiet', '--', localPath], gitOptions)).status !== 0) throw new Error(`Deployment stopped: ${localPath} must be ignored by Git`)
  }
  if (!existsSync(envFile)) {
    mkdirSync(dirname(envFile), { recursive: true })
    writeFileSync(envFile, readFileSync(resolve(root, 'config/cloudflare/deploy.env.example')), { mode: 0o600, flag: 'wx' })
    console.log(`Created local deployment configuration: ${inProject ? localPath : 'external configuration file'}`)
  }
  chmodSync(envFile, 0o600)
  const env = { ...parseEnv(readFileSync(envFile, 'utf8')), ...environment, WRANGLER_LOG_PATH: resolve(root, '.wrangler/logs') }
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js')
  const options = { cwd: root, env }
  async function execute(command, commandArgs, settings = {}) {
    const result = await run(command, commandArgs, { ...options, ...settings })
    if (result.status !== 0) throw new Error(`Command failed: ${command === process.execPath ? 'wrangler ' + commandArgs[1] : command + ' ' + commandArgs.join(' ')}. Deployment stopped.`)
    return result
  }
  const names = { backend: env.CF_BACKEND_WORKER_NAME || 'colwork-backend', frontend: env.CF_FRONTEND_WORKER_NAME || 'colwork-frontend' }
  for (const name of Object.values(names)) if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`Invalid Worker name: ${name}`)
  if (names.backend === names.frontend) throw new Error('Frontend and backend Worker names must differ')
  const configDir = resolve(root, '.wrangler/deploy-config')
  mkdirSync(configDir, { recursive: true })
  const configs = {}
  for (const kind of ['backend', 'frontend']) {
    const config = JSON.parse(readFileSync(resolve(root, `config/cloudflare/wrangler.${kind}.json`), 'utf8'))
    config.name = names[kind]
    config.main = resolve(root, 'server/cloudflare', kind + '.mjs')
    config.$schema = resolve(root, 'node_modules/wrangler/config-schema.json')
    if (config.assets) config.assets.directory = resolve(root, 'site-dist')
    if (config.services) config.services[0].service = names.backend
    if (env.CLOUDFLARE_ACCOUNT_ID) config.account_id = env.CLOUDFLARE_ACCOUNT_ID
    const domain = env[`CF_${kind.toUpperCase()}_CUSTOM_DOMAIN`]
    if (domain) {
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) throw new Error('Custom domains must be hostnames without a protocol')
      config.routes = [{ pattern: domain, custom_domain: true }]
    }
    configs[kind] = config
  }
  await execute('npm', ['run', 'build:site'])
  if (!dryRun) {
    async function identity() {
      const result = await run(process.execPath, [wrangler, 'whoami', '--json'], { ...options, capture: true })
      try {
        const user = JSON.parse(result.stdout)
        if (typeof user.loggedIn !== 'boolean') throw new Error('Invalid identity response')
        return { status: result.status, user }
      } catch { throw new Error('Cannot check Cloudflare login. Run npx wrangler whoami to diagnose the connection; no deployment has started.') }
    }
    let auth = await identity()
    if (!auth.user.loggedIn) {
      if ((env.CI && env.CI !== 'false' && env.CI !== '0') || args.includes('--no-login') || env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_KEY) throw new Error('Cloudflare authentication failed. Configure valid credentials in the shell/CI, or run npx wrangler login locally. No deployment has started.')
      console.log('Cloudflare authorization required; opening Wrangler OAuth. Credentials stay in Wrangler’s user credential store.')
      await execute(process.execPath, [wrangler, 'login'])
      auth = await identity()
    }
    if (auth.status !== 0 || !auth.user.loggedIn) throw new Error('Cloudflare authorization was not completed. No deployment has started.')
    if (!env.CLOUDFLARE_ACCOUNT_ID) {
      if (auth.user.accounts?.length !== 1) throw new Error('Set CLOUDFLARE_ACCOUNT_ID in the ignored deploy.env to select one of your accounts. No deployment has started.')
      env.CLOUDFLARE_ACCOUNT_ID = auth.user.accounts[0].id
    }
    for (const config of Object.values(configs)) config.account_id = env.CLOUDFLARE_ACCOUNT_ID
  }
  const urls = {}
  for (const kind of ['backend', 'frontend']) {
    const path = resolve(configDir, kind + '.json')
    // Write only deployment fields; never serialize the environment or tokens.
    writeFileSync(path, JSON.stringify(configs[kind], null, 2) + '\n', { mode: 0o600 })
    const deployArgs = [wrangler, 'deploy', '--config', path]
    if (dryRun) deployArgs.push('--dry-run', '--outdir', resolve(root, 'build/workers', kind))
    console.log(`${dryRun ? 'Checking' : 'Deploying'} ${names[kind]}...`)
    const result = await execute(process.execPath, deployArgs)
    urls[kind] = configs[kind].routes?.[0]?.pattern ? `https://${configs[kind].routes[0].pattern}` : result.stdout.match(/https:\/\/[^\s]+\.workers\.dev\b/)?.[0]
  }
  if (!dryRun) {
    await verify(urls)
    writeFileSync(resolve(root, '.wrangler/deploy-result.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), workers: names, urls }, null, 2) + '\n', { mode: 0o600 })
    console.log(`Deployment verified. Frontend: ${urls.frontend}\nBackend: ${urls.backend}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deploy().catch(error => { console.error(error.message); process.exitCode = 1 })
}
