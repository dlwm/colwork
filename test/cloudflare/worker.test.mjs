import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'
import { chromium } from '@playwright/test'
import { verifyDeployment } from '../../script/deploy-cloudflare.mjs'

async function until(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for Cloudflare test condition')
}

test('Cloudflare runtime: HTTP, Yjs, presence, room isolation, browser and restart persistence', { timeout: 120000 }, async t => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const storage = await mkdtemp(resolve(tmpdir(), 'colwork-cloudflare-test-'))
  const base = `http://127.0.0.1:${port}`
  let process, output = '', browser
  const clients = []
  async function stop() {
    if (!process || process.exitCode !== null) return
    const exited = new Promise(resolve => process.once('exit', resolve))
    process.kill('SIGTERM')
    await exited
  }
  async function start() {
    output = ''
    process = spawn(globalThis.process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'config/cloudflare/wrangler.frontend.json', '--config', 'config/cloudflare/wrangler.backend.json', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', storage], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...globalThis.process.env, WRANGLER_SEND_METRICS: 'false' } })
    process.stdout.on('data', chunk => { output += chunk })
    process.stderr.on('data', chunk => { output += chunk })
    await until(async () => {
      if (process.exitCode !== null) throw new Error(output)
      try { return (await fetch(`${base}/health`)).ok } catch { return false }
    })
  }
  async function connect(room, id = 'test-user') {
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(base.replace('http:', 'ws:') + '/rooms', encodeURIComponent(room), doc, { WebSocketPolyfill: WebSocket, disableBc: true, params: { userId: id } })
    const client = { doc, provider }
    clients.push(client)
    await until(() => provider.synced)
    return client
  }
  function disconnect(client) { client.provider.destroy(); client.doc.destroy() }
  t.after(async () => {
    for (const client of clients) disconnect(client)
    await browser?.close()
    await stop()
    await rm(storage, { recursive: true, force: true })
  })
  await start()
  await t.test('deployment smoke checks verify assets, proxy health and WebSocket handshake', async () => {
    await verifyDeployment({ frontend: base, backend: base })
  })
  await t.test('HTTP routes and settings validation', async () => {
    assert.equal((await fetch(`${base}/rooms/demo`)).status, 426)
    assert.equal((await fetch(`${base}/api/missing`)).status, 404)
    assert.equal((await fetch(`${base}/internal/users/test-user`)).status, 404)
    const response = await fetch(`${base}/api/users`, { method: 'POST', body: JSON.stringify({ id: 'test-user', nickname: '协作者', color: '#123456', delay: 20 }) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).delay, 20)
    assert.equal((await fetch(`${base}/api/users`, { method: 'POST', body: '{}' })).status, 400)
    assert.match(await (await fetch(base)).text(), /\/assets\//)
  })
  const first = await connect('持久化 / 测试')
  const second = await connect('持久化 / 测试')
  const isolated = await connect('another-room')
  await t.test('real WebSocket collaboration and presence removal', async () => {
    first.doc.getMap('cells').set('0:0', 'Cloudflare 协作')
    await until(() => second.doc.getMap('cells').get('0:0') === 'Cloudflare 协作')
    assert.equal(isolated.doc.getMap('cells').size, 0)
    second.doc.getMap('cells').set('0:1', '来自第二个客户端')
    await until(() => first.doc.getMap('cells').has('0:1'))
    first.provider.awareness.setLocalStateField('user', { name: '测试用户', color: '#123456' })
    await until(() => second.provider.awareness.getStates().get(first.doc.clientID)?.user?.name === '测试用户')
    second.provider.awareness.setLocalStateField('user', { name: '第二个用户' })
    const observer = await connect('持久化 / 测试')
    await until(() => observer.provider.awareness.getStates().get(second.doc.clientID)?.user?.name === '第二个用户')
    disconnect(observer)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(first.provider.awareness.getStates().get(second.doc.clientID)?.user?.name, '第二个用户')
    const id = first.doc.clientID
    disconnect(first)
    await until(() => !second.provider.awareness.getStates().has(id))
  })
  await t.test('production Vue and React pages synchronize and do not resurrect cleared cells', async () => {
    browser = await chromium.launch({ executablePath: globalThis.process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined })
    const vue = await browser.newPage()
    const react = await browser.newPage()
    const errors = []
    for (const page of [vue, react]) {
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => assert.ok(!/127\.0\.0\.1:(1234|4444)/.test(request.url()), 'Cloud build must use same-origin endpoints'))
    }
    await vue.goto(base)
    assert.equal(await vue.getByRole('link', { name: /github.com\/dlwm\/colwork/ }).getAttribute('href'), 'https://github.com/dlwm/colwork')
    await vue.getByRole('link', { name: '打开 Vue 示例' }).click()
    const cell = page => page.locator('td[data-key="0:0"]')
    await until(async () => (await cell(vue).textContent())?.includes('设计协作表格'))
    await cell(vue).dblclick()
    await vue.locator('textarea').fill('浏览器持久化测试')
    await vue.locator('textarea').press('Enter')
    await react.goto(base)
    await react.getByRole('link', { name: '打开 React 示例' }).click()
    await until(async () => (await cell(react).textContent())?.includes('浏览器持久化测试'))
    await vue.getByRole('button', { name: '保护', exact: true }).click()
    await vue.locator('.colwork-table__context-menu').getByRole('button', { name: '锁定选区', exact: true }).click()
    await until(async () => (await cell(react).getAttribute('aria-readonly')) === 'true')
    await vue.reload()
    await until(async () => (await cell(vue).getAttribute('aria-readonly')) === 'true')
    const demo = await connect('colwork-demo')
    assert.equal(demo.doc.getMap('colwork-metadata').get('initialized'), true)
    demo.doc.transact(() => { demo.doc.getMap('cells').clear(); demo.doc.getMap('locks').clear() })
    await until(async () => (await cell(vue).textContent()) === '')
    await vue.reload()
    await until(async () => await vue.locator('td[data-key="0:0"]').count() > 0)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(await cell(vue).textContent(), '')
    assert.deepEqual(errors, [])
    await react.getByRole('link', { name: '返回首页' }).click()
    assert.equal(await react.getByRole('heading', { name: 'Colwork.' }).count(), 1)
    await vue.close(); await react.close()
  })
  await t.test('large document and protection survive Worker restart', async () => {
    const map = second.doc.getMap('cells')
    second.doc.transact(() => {
      map.set('large', 'x'.repeat(200000))
      second.doc.getMap('locks').set('0:0', { salt: 'salt', hash: 'hash', version: 1 })
      second.doc.getMap('styles').set('0:0', { bold: true })
    })
    const witness = await connect('持久化 / 测试')
    await until(() => witness.doc.getMap('cells').get('large')?.length === 200000)
    for (const client of clients) disconnect(client)
    await stop()
    await start()
    const restored = await connect('持久化 / 测试')
    assert.equal(restored.doc.getMap('cells').get('large').length, 200000)
    assert.equal(restored.doc.getMap('cells').get('0:1'), '来自第二个客户端')
    assert.equal(restored.doc.getMap('locks').get('0:0').hash, 'hash')
    assert.equal(restored.doc.getMap('styles').get('0:0').bold, true)
    const demo = await connect('colwork-demo')
    assert.equal(demo.doc.getMap('cells').size, 0)
    assert.equal(demo.doc.getMap('colwork-metadata').get('initialized'), true)
  })
})
