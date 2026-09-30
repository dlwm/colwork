import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { deploy, runCommand } from '../../script/deploy-cloudflare.mjs'

async function fixture(t, settings = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'colwork-deploy-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(resolve(root, 'config/cloudflare'), { recursive: true })
  for (const file of ['.gitignore', 'config/cloudflare/deploy.env.example', 'config/cloudflare/wrangler.backend.json', 'config/cloudflare/wrangler.frontend.json']) await copyFile(file, resolve(root, file))
  await runCommand('git', ['init', '--quiet'], { cwd: root, env: process.env, capture: true })
  const calls = []
  const environment = { PATH: process.env.PATH, ...settings.environment }
  let loggedIn = settings.loggedIn ?? true
  const run = async (command, args, options) => {
    calls.push({ command, args })
    if (command === 'git') return runCommand(command, args, { ...options, env: process.env })
    if (args[1] === 'whoami') return { status: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn, accounts: settings.accounts ?? [{ id: 'test-account' }] }) }
    if (args[1] === 'login') { loggedIn = !settings.cancelLogin; return { status: loggedIn ? 0 : 1, stdout: '' } }
    if (command === 'npm' && settings.buildFails) return { status: 1, stdout: '' }
    return { status: 0, stdout: 'https://example.workers.dev' }
  }
  const verified = []
  const options = { root, environment, args: settings.args ?? [], run, verify: async urls => { verified.push(urls); if (settings.verifyFails) throw new Error('Verification failed') } }
  return { root, calls, options, verified }
}

test('authenticated deployment selects the only account, deploys in order and keeps tokens out of files', async t => {
  const f = await fixture(t, { environment: { CLOUDFLARE_API_TOKEN: 'test-secret-never-write' } })
  await deploy(f.options)
  assert.equal(f.calls.some(call => call.args[1] === 'login'), false)
  const deployments = f.calls.filter(call => call.args[1] === 'deploy')
  assert.match(deployments[0].args[3], /backend\.json$/)
  assert.match(deployments[1].args[3], /frontend\.json$/)
  const backend = JSON.parse(await readFile(resolve(f.root, '.wrangler/deploy-config/backend.json'), 'utf8'))
  const frontendText = await readFile(resolve(f.root, '.wrangler/deploy-config/frontend.json'), 'utf8')
  assert.equal(backend.account_id, 'test-account')
  assert.equal(JSON.parse(frontendText).services[0].service, backend.name)
  assert.ok(!frontendText.includes('test-secret-never-write'))
  const receipt = await readFile(resolve(f.root, '.wrangler/deploy-result.json'), 'utf8')
  assert.ok(!receipt.includes('test-secret-never-write'))
  assert.deepEqual(f.verified[0], { backend: 'https://api.colwork.kuzuma.asia', frontend: 'https://colwork.kuzuma.asia' })
  assert.equal((await stat(resolve(f.root, 'config/cloudflare/deploy.env'))).mode & 0o777, 0o600)
})

test('local first deployment automatically authorizes and rechecks identity', async t => {
  const f = await fixture(t, { loggedIn: false })
  await deploy(f.options)
  assert.equal(f.calls.filter(call => call.args[1] === 'login').length, 1)
  assert.equal(f.calls.filter(call => call.args[1] === 'whoami').length, 2)
  assert.equal(f.verified.length, 1)
})

test('cancelled OAuth never publishes a Worker', async t => {
  const f = await fixture(t, { loggedIn: false, cancelLogin: true })
  await assert.rejects(deploy(f.options), /Command failed: wrangler login/)
  assert.equal(f.calls.some(call => call.args[1] === 'deploy'), false)
})

test('CI and --no-login never start OAuth when unauthenticated', async t => {
  for (const settings of [{ environment: { CI: 'true' } }, { args: ['--no-login'] }]) {
    const f = await fixture(t, { ...settings, loggedIn: false })
    await assert.rejects(deploy(f.options), /authentication failed/)
    assert.equal(f.calls.some(call => ['login', 'deploy'].includes(call.args[1])), false)
  }
})

test('multiple accounts require explicit account selection before publishing', async t => {
  const f = await fixture(t, { accounts: [{ id: 'one' }, { id: 'two' }] })
  await assert.rejects(deploy(f.options), /Set CLOUDFLARE_ACCOUNT_ID/)
  assert.equal(f.calls.some(call => call.args[1] === 'deploy'), false)
})

test('Git tracking local secrets blocks deployment before build or login', async t => {
  const f = await fixture(t)
  await writeFile(resolve(f.root, 'config/cloudflare/deploy.env'), 'CLOUDFLARE_API_TOKEN=test-secret\n')
  await runCommand('git', ['add', '-f', 'config/cloudflare/deploy.env'], { cwd: f.root, env: process.env, capture: true })
  await assert.rejects(deploy(f.options), /tracked by Git/)
  assert.equal(f.calls.some(call => call.command !== 'git'), false)
})

test('dry-run needs no authorization and never runs live verification', async t => {
  const f = await fixture(t, { loggedIn: false, args: ['--dry-run'] })
  await deploy(f.options)
  assert.equal(f.calls.some(call => ['login', 'whoami'].includes(call.args[1])), false)
  const deployments = f.calls.filter(call => call.args[1] === 'deploy')
  assert.equal(deployments.length, 2)
  assert.ok(deployments.every(call => call.args.includes('--dry-run')))
  assert.equal(f.verified.length, 0)
})

test('build failure stops before authorization and publishing; verification failure cannot report success', async t => {
  const build = await fixture(t, { buildFails: true })
  await assert.rejects(deploy(build.options), /Command failed: npm/)
  assert.equal(build.calls.some(call => ['login', 'whoami', 'deploy'].includes(call.args[1])), false)
  const verify = await fixture(t, { verifyFails: true })
  await assert.rejects(deploy(verify.options), /Verification failed/)
  await assert.rejects(readFile(resolve(verify.root, '.wrangler/deploy-result.json')), { code: 'ENOENT' })
})
