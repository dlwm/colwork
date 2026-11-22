import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { createHmac } from 'node:crypto'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { createDecoder, readVarUint } from 'lib0/decoding'
import WebSocket from 'ws'
import { chromium } from '@playwright/test'
import { verifyDeployment } from '../../script/deploy-cloudflare.mjs'
import { syncRequest, syncUpdate } from '../../server/cloudflare/protocol.mjs'
import ExcelJS from 'exceljs'
import { isSocketChunk, sendSocketMessage, socketReceipt, SocketMessageReader } from '../../src/socketFrames.ts'

class ChunkedTestSocket extends WebSocket {
  reader = new SocketMessageReader()

  send(data) { sendSocketMessage(data, frame => super.send(frame)) }

  emit(event, data, ...args) {
    if (event === 'message' && args[0]) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      if (isSocketChunk(bytes) || this.reader.bytes) {
        const message = this.reader.read(bytes)
        return message ? super.emit(event, message.buffer, ...args) : true
      }
    }
    return super.emit(event, data, ...args)
  }
}

const testSessionSecret = 'colwork-local-integration-session-key'
function sessionToken(documents, options = {}) {
  const claims = Buffer.from(JSON.stringify({
    aud: 'colwork', sub: 'account-42', name: '真实登录用户', exp: Math.floor(Date.now() / 1000) + 300, documents, ...options,
  })).toString('base64url')
  const payload = `v1.${claims}`
  return `${payload}.${createHmac('sha256', testSessionSecret).update(payload).digest('base64url')}`
}

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
  const backendConfigPath = resolve(storage, 'backend.test.json')
  const backendConfig = JSON.parse(await readFile('config/cloudflare/wrangler.backend.json', 'utf8'))
  await writeFile(backendConfigPath, JSON.stringify({
    ...backendConfig, main: resolve('server/cloudflare/backend.mjs'), vars: { COLWORK_SESSION_SECRET: testSessionSecret },
  }))
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
    process = spawn(globalThis.process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'config/cloudflare/wrangler.frontend.json', '--config', backendConfigPath, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', storage], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...globalThis.process.env, WRANGLER_SEND_METRICS: 'false' } })
    process.stdout.on('data', chunk => { output += chunk })
    process.stderr.on('data', chunk => { output += chunk })
    await until(async () => {
      if (process.exitCode !== null) throw new Error(output)
      try { return (await fetch(`${base}/health`)).ok } catch { return false }
    })
  }
  async function connect(room, id = 'test-user', chunked = false) {
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(base.replace('http:', 'ws:') + '/rooms', encodeURIComponent(room), doc, { WebSocketPolyfill: chunked ? ChunkedTestSocket : WebSocket, disableBc: true, params: { userId: id, ...(chunked ? { colworkChunks: '1' } : {}) } })
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
    await cell(vue).click()
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
  await t.test('browser Excel import reaches peers above the old message limit and survives reconnect', async () => {
    const room = 'chunked-excel'
    const writer = await browser.newPage()
    const reader = await browser.newPage()
    try {
      const path = `${base}/test/workbook?room=${room}`
      await writer.goto(path)
      await writer.locator('#import').waitFor()
      await until(() => writer.locator('#import').isEnabled())
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Large import')
      const text = 'synthetic workbook '.repeat(60)
      for (let row = 1; row <= 1200; row++) sheet.getCell(`A${row}`).value = text + row
      assert.ok(Buffer.byteLength(text) * 1200 > 1024 * 1024)
      await writer.locator('#import').setInputFiles({
        name: 'large.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      })
      await until(async () => (await writer.locator('#status').textContent()) === '操作完成')
      await reader.goto(path)
      const tab = reader.getByRole('button', { name: 'Large import', exact: true })
      await tab.click()
      const first = reader.locator('td[data-key="0:0"] .colwork-table__cell-value')
      await until(async () => (await first.textContent()) === text + '1')
      await reader.reload()
      await tab.click()
      await until(async () => (await first.textContent()) === text + '1')
    } finally { await writer.close(); await reader.close() }
  })
  await t.test('offline edits above one MiB catch up through a chunked sync-step reply', async () => {
    const writer = await connect('offline-chunked', 'writer', true)
    const reader = await connect('offline-chunked', 'reader', true)
    const text = 'offline cell text '.repeat(60)
    writer.provider.disconnect()
    await until(() => !writer.provider.wsconnected)
    writer.doc.transact(() => {
      for (let row = 0; row < 1200; row++) writer.doc.getMap('cells').set(`${row}:0`, text + row)
    })
    assert.equal(reader.doc.getMap('cells').size, 0)
    writer.provider.connect()
    await until(() => reader.doc.getMap('cells').size === 1200)
    assert.equal(reader.doc.getMap('cells').get('1199:0'), text + '1199')
    for (let i = 0; i < 130; i++) writer.doc.getMap('cells').set('0:1', String(i))
    await until(() => reader.doc.getMap('cells').get('0:1') === '129')
  })
  await t.test('workbook exposes a save receipt only after explicit Worker confirmation', async () => {
    const page = await browser.newPage()
    try {
      const badge = page.locator('#save-status')
      await page.goto(`${base}/test/workbook?room=save-receipt`)
      await until(async () => (await badge.textContent()).includes('初始同步完成'))
      assert.doesNotMatch(await badge.textContent(), /已确认落库/)
      await page.locator('td[data-key="0:0"]').click()
      const input = page.getByRole('textbox', { name: '公式栏' })
      await input.fill('confirmed after restart')
      await until(async () => (await badge.textContent()).includes('有未提交的单元格输入'))
      await input.press('Enter')
      await until(async () => (await badge.textContent()).includes('有未确认落库的改动'))
      await page.getByRole('button', { name: '确认落库' }).click()
      await until(async () => (await badge.textContent()).includes('已确认落库'))
    } finally { await page.close() }
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
    const offline = await connect('offline-chunked', 'after-restart', true)
    assert.equal(offline.doc.getMap('cells').size, 1201)
    assert.equal(offline.doc.getMap('cells').get('0:1'), '129')
    const confirmed = await connect('workbook-save-receipt')
    assert.equal(confirmed.doc.getMap('cells').get('0:0'), 'confirmed after restart')
    const chunked = await browser.newPage()
    try {
      await chunked.goto(`${base}/test/workbook?room=chunked-excel`)
      await chunked.getByRole('button', { name: 'Large import', exact: true }).click()
      assert.match(await chunked.locator('td[data-key="0:0"]').textContent(), /synthetic workbook/)
    } finally { await chunked.close() }
  })
  await t.test('protected documents verify login, isolate rooms, and enforce export and write access', async () => {
    const room = 'staff-sheet'
    const grant = { id: room, canEdit: true, allowExport: true, viewerWatermark: true, fixedWatermark: '内部文件' }
    const editorToken = sessionToken([grant])
    const viewerToken = sessionToken([{ ...grant, canEdit: false, allowExport: false }], { name: '只读用户' })
    const cookie = token => `colwork_session=${token}`
    const request = (action, token) => fetch(`${base}/api/documents/${room}/${action}`, {
      headers: token ? { Cookie: cookie(token), 'x-colwork-can-edit': 'true' } : {},
    })
    assert.equal((await request('view-policy')).status, 401)
    assert.equal((await request('export', `${editorToken.slice(0, -43)}${'a'.repeat(43)}`)).status, 401)
    assert.equal((await request('view-policy', sessionToken([grant], { exp: 1 }))).status, 401)
    assert.equal((await request('export', sessionToken([{ ...grant, id: 'other' }]))).status, 403)
    const viewerPolicy = await request('view-policy?allowExport=1&name=forged', viewerToken)
    assert.equal(viewerPolicy.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await viewerPolicy.json(), {
      displayName: '只读用户', canEdit: false,
      viewPolicy: { allowExport: false, watermark: { viewerText: '只读用户', fixedText: '内部文件' } },
    })
    assert.equal((await request('export?allowExport=1', viewerToken)).status, 403)
    const rejectedSocket = headers => new Promise((resolve, reject) => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + `/rooms/private/${room}`, { headers })
      socket.on('error', reject)
      socket.once('open', () => { socket.close(); reject(new Error('Unexpected WebSocket access')) })
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode)
      })
    })
    assert.equal(await rejectedSocket({ Origin: base }), 401)
    assert.equal(await rejectedSocket({ Origin: 'https://other.example', Cookie: cookie(editorToken) }), 403)

    const editor = await browser.newContext({ acceptDownloads: true })
    const viewer = await browser.newContext()
    try {
      await editor.addCookies([{ name: 'colwork_session', value: editorToken, url: base, httpOnly: true }])
      await viewer.addCookies([{ name: 'colwork_session', value: viewerToken, url: base, httpOnly: true }])
      const page = await editor.newPage()
      await page.goto(`${base}/test/document.html?id=${room}`)
      const cell = page.locator('td[data-key="0:0"]')
      await until(async () => await cell.getAttribute('aria-readonly') === 'false')
      await cell.dblclick()
      await page.locator('textarea').fill('已同步的私有文档')
      await page.locator('textarea').press('Enter')
      const read = await viewer.newPage()
      await read.goto(`${base}/test/document.html?id=${room}&allowExport=1`)
      await until(async () => await read.locator('td[data-key="0:0"] .colwork-table__cell-value').textContent() === '已同步的私有文档')
      assert.equal(await read.locator('td[data-key="0:0"]').getAttribute('aria-readonly'), 'true')
      assert.equal(await read.locator('#download').isDisabled(), true)
      assert.equal(await read.locator('#xlsx').isDisabled(), true)
      assert.equal(await read.locator('#import').isDisabled(), true)
      assert.equal(await read.locator('.colwork-table__watermark').isVisible(), true)
      assert.equal(await read.locator('#status').textContent(), '只读用户')
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()])
      assert.equal(download.suggestedFilename(), 'colwork.snapshot.json')
      const [xlsx] = await Promise.all([page.waitForEvent('download'), page.locator('#xlsx').click()])
      assert.equal(xlsx.suggestedFilename(), 'colwork.xlsx')
      const exportedWorkbook = new ExcelJS.Workbook()
      await exportedWorkbook.xlsx.readFile(await xlsx.path())
      assert.equal(exportedWorkbook.worksheets[0].getCell('A1').value, '已同步的私有文档')
      const importedWorkbook = new ExcelJS.Workbook()
      const imported = importedWorkbook.addWorksheet('Budget')
      imported.getCell('A1').value = 12
      imported.getCell('B1').value = { formula: 'A1*2', result: 24 }
      await page.locator('#import').setInputFiles({
        name: 'budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from(await importedWorkbook.xlsx.writeBuffer()),
      })
      await read.getByRole('button', { name: 'Budget', exact: true }).click()
      await until(async () => await read.locator('td[data-key="0:1"] .colwork-table__cell-value').textContent() === '24')

      const readOnlySocket = await new Promise((resolve, reject) => {
        const socket = new WebSocket(base.replace('http:', 'ws:') + `/rooms/private/${room}?colworkChunks=1`, {
          headers: { Cookie: cookie(viewerToken), Origin: base },
        })
        socket.on('error', reject)
        socket.once('open', () => resolve(socket))
      })
      try {
        const forged = new Y.Doc()
        forged.getMap('cells').set('0:1', 'forged write')
        const confirmed = new Promise(resolve => {
          readOnlySocket.on('message', message => {
            const decoder = createDecoder(new Uint8Array(message))
            if (readVarUint(decoder) === 0 && readVarUint(decoder) === 1) resolve()
          })
        })
        // A sync reply confirms the Worker processed the preceding update frame.
        readOnlySocket.send(syncUpdate(Y.encodeStateAsUpdate(forged)))
        readOnlySocket.send(syncRequest(forged))
        await confirmed
        forged.destroy()
        const closed = new Promise(resolve => readOnlySocket.once('close', resolve))
        readOnlySocket.send(socketReceipt(1))
        assert.equal(await closed, 1008)
      } finally { readOnlySocket.close() }
      const response = await request('export', editorToken)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-disposition'), /^attachment;/)
      const archive = await response.json()
      const exported = new Y.Doc()
      Y.applyUpdate(exported, Buffer.from(archive.snapshot, 'base64'))
      assert.equal(exported.getMap('cells').get('0:0'), '已同步的私有文档')
      assert.equal(exported.getMap('cells').has('0:1'), false)
      exported.destroy()
      const publicRoom = await connect(room)
      assert.equal(publicRoom.doc.getMap('cells').size, 0)
    } finally { await editor.close(); await viewer.close() }
  })
})
