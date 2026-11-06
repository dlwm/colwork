import { test, expect } from '@playwright/test'
import { WebSocketServer } from 'ws'
import { createRequire } from 'node:module'
const { setupWSConnection } = createRequire(import.meta.url)('y-websocket/bin/utils')
let server

test.beforeAll(async () => {
  server = new WebSocketServer({ port: 18444, host: '127.0.0.1' })
  server.on('connection', setupWSConnection)
  await new Promise((resolve, reject) => { server.on('listening', resolve); server.on('error', reject) })
})
test.afterAll(async () => {
  for (const client of server.clients) client.terminate()
  await new Promise(resolve => server.close(resolve))
})

for (const format of ['es', 'umd']) {
  test(`built ${format} public entry and stylesheet mount a usable external table`, async ({ page }) => {
    await page.goto('/test/e2e/fixture.html')
    await page.evaluate(async format => {
      const { Y, YAwareness, YWebrtc, YWebsocket } = await import('/test/e2e/package-fixture.ts')
      const css = document.createElement('link')
      css.rel = 'stylesheet'
      css.href = '/dist/colwork.css'
      document.head.append(css)
      await new Promise((resolve, reject) => { css.onload = resolve; css.onerror = reject })
      let ColworkTable
      if (format === 'es') ({ ColworkTable } = await import('/dist/colwork.js'))
      else {
        Object.assign(window, { Y, YAwareness, YWebrtc, YWebsocket })
        const script = document.createElement('script')
        script.src = '/dist/colwork.umd.cjs'
        document.body.append(script)
        await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject })
        ColworkTable = window.Colwork.ColworkTable
      }
      window.doc = new Y.Doc()
      window.awareness = new YAwareness.Awareness(doc)
      window.table = new ColworkTable(document.querySelector('#table'), { transport: 'external', collaboration: { document: doc, awareness }, user: 'Package test' })
    }, format)
    await expect(page.locator('.colwork-table__viewport')).toHaveCSS('overflow', 'auto')
    const cell = page.locator('td[data-key="0:0"]')
    await cell.dblclick()
    await page.locator('textarea').fill(`${format} package entry`)
    await page.keyboard.press('Enter')
    await expect(cell).toHaveText(`${format} package entry`)
    expect(await page.evaluate(() => doc.getMap('cells').get('0:0'))).toBe(`${format} package entry`)
    await page.evaluate(() => { table.destroy(); awareness.destroy(); doc.destroy() })
  })
}

test('existing Vue and React demos collaborate through a local isolated WebSocket server', async ({ page, browser }) => {
  async function configure(page) {
    await page.route('http://127.0.0.1:4444/api/users', route => route.fulfill({ status: 200, body: '{}', headers: {
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type',
    } }))
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          const destination = new URL(url)
          if (destination.hostname === '127.0.0.1' && destination.port === '1234') destination.port = '18444'
          super(destination.toString(), protocols)
        }
      }
    })
  }
  const context = await browser.newContext()
  try {
    const peer = await context.newPage()
    await configure(page)
    await configure(peer)
    await page.goto('/test/vue.html')
    await peer.goto('/test/react.html')
    const source = page.locator('td[data-key="1:4"]')
    const destination = peer.locator('td[data-key="1:4"]')
    await expect(source).toBeVisible()
    await expect(destination).toBeVisible()
    await source.click()
    await page.keyboard.press('Space')
    await page.locator('textarea').fill('Vue to React integration')
    await page.keyboard.press('Enter')
    await expect(destination.locator('.colwork-table__cell-value')).toHaveText('Vue to React integration')
    await destination.click()
    await peer.keyboard.press('Space')
    await peer.locator('textarea').fill('React to Vue integration')
    await peer.keyboard.press('Enter')
    await expect(source.locator('.colwork-table__cell-value')).toHaveText('React to Vue integration')
  } finally { await context.close() }
})
