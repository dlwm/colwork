import { test, expect } from '@playwright/test'

const overlaySelector = '.colwork-table__watermark'
const viewportSelector = '.colwork-table__viewport'

async function mount(page, policy) {
  await page.addInitScript(() => {
    const attachShadow = Element.prototype.attachShadow
    window.testShadowRoots = new WeakMap()
    Element.prototype.attachShadow = function (options) {
      const root = attachShadow.call(this, options)
      testShadowRoots.set(this, root)
      return root
    }
  })
  await page.goto('/test/e2e/fixture.html')
  await page.evaluate(async viewPolicy => {
    const { ColworkTable, Y, Awareness } = await import('/test/e2e/external-fixture.ts')
    window.doc = new Y.Doc()
    window.awareness = new Awareness(doc)
    window.options = { transport: 'external', collaboration: { document: doc, awareness }, user: 'Fallback user', rowCount: 70, columnCount: 30 }
    window.table = new ColworkTable(document.querySelector('#table'), { ...options, viewPolicy })
  }, policy)
}

function watermarkText(locator) {
  return locator.evaluate(overlay => Array.from(testShadowRoots.get(overlay).querySelectorAll('text'), text => text.textContent))
}

test('watermarks render independently per viewer and cover the viewport without blocking editing', async ({ page }) => {
  await mount(page)
  const overlay = page.locator(overlaySelector)
  const viewport = page.locator(viewportSelector)
  const withoutWatermark = await viewport.screenshot()
  await page.evaluate(() => table.setViewPolicy({ watermark: { viewerText: ' 本地查看者   U-42 ' } }))
  await expect(overlay).toBeVisible()
  expect(await watermarkText(overlay)).toEqual(['本地查看者 U-42'])
  expect((await viewport.screenshot()).equals(withoutWatermark)).toBe(false)

  await page.evaluate(() => {
    const peer = document.body.appendChild(document.createElement('div'))
    peer.id = 'peer'
    window.viewer = new table.constructor(peer, { ...options, readOnly: true, viewPolicy: { watermark: { fixedText: '内部资料' } } })
    table.setViewPolicy({ watermark: { viewerText: '本地查看者 U-42', fixedText: '内部资料' } })
    awareness.setLocalStateField('user', { name: 'Changed awareness name' })
  })
  const editableOverlay = page.locator(`#table ${overlaySelector}`)
  const editableViewport = page.locator(`#table ${viewportSelector}`)
  expect(await watermarkText(editableOverlay)).toEqual(['本地查看者 U-42', '内部资料'])
  expect(await watermarkText(page.locator(`#peer ${overlaySelector}`))).toEqual(['内部资料'])
  expect(await editableOverlay.boundingBox()).toEqual(await editableViewport.boundingBox())

  await page.evaluate(() => table.setFrozenPanes(1, 1))
  await editableViewport.evaluate(view => view.scrollTo(400, 500))
  await expect.poll(() => editableViewport.evaluate(view => view.scrollTop)).toBe(500)
  expect(await editableOverlay.boundingBox()).toEqual(await editableViewport.boundingBox())
  const visibleCell = editableViewport.locator('td[data-key="0:0"]')
  await visibleCell.dblclick()
  await editableViewport.locator('textarea').fill('Shared value')
  await editableViewport.locator('textarea').press('Enter')
  await expect(visibleCell).toHaveText('Shared value')
  expect(await page.evaluate(() => [...doc.share.keys()].some(key => /watermark/i.test(key)))).toBe(false)

  await page.evaluate(() => table.setViewPolicy({ watermark: { viewerText: '  ', fixedText: '' } }))
  await expect(editableOverlay).toHaveCount(0)
  await expect(page.locator(`#peer ${overlaySelector}`)).toHaveCount(1)
})

test('watermark restores removed or modified DOM and resists page CSS until policy changes', async ({ page }) => {
  await mount(page, { watermark: { fixedText: '内部资料' } })
  const overlay = page.locator(overlaySelector)
  expect(await overlay.evaluate(element => element.shadowRoot)).toBeNull()
  await page.addStyleTag({ content: `#table ${overlaySelector} { display: none !important; opacity: 0 !important; visibility: hidden !important; }` })
  await expect(overlay).toBeVisible()
  await expect(overlay).toHaveCSS('opacity', '1')

  await overlay.evaluate(element => {
    window.originalOverlay = element
    element.style.cssText = 'display:none!important; transform:scale(0)!important'
    element.hidden = true
    element.className = 'changed'
    element.remove()
    testShadowRoots.get(element).querySelector('text').textContent = 'Modified'
    testShadowRoots.get(element).querySelector('rect').remove()
  })
  await expect(overlay).toBeVisible()
  expect(await overlay.evaluate(element => element === originalOverlay && !element.hidden && !element.hasAttribute('style'))).toBe(true)
  expect(await watermarkText(overlay)).toEqual(['内部资料'])
  expect(await overlay.evaluate(element => !!testShadowRoots.get(element).querySelector('rect'))).toBe(true)

  await page.evaluate(() => table.destroy())
  await expect(overlay).toHaveCount(0)
  expect(await page.evaluate(() => originalOverlay.isConnected)).toBe(false)
})

test('export policy gates snapshot and update log without changing host data', async ({ page }) => {
  await mount(page, { allowExport: false })
  const result = await page.evaluate(() => {
    doc.getMap('cells').set('0:0', 'Host can still save')
    const denied = ['getYjsSnapshot', 'getYjsUpdateLog'].map(method => {
      try { table[method](); return 'unexpected success' } catch (error) { return error.name }
    })
    const allowedBefore = table.canExport()
    table.setViewPolicy({ allowExport: true })
    const snapshot = table.getYjsSnapshot()
    const updates = table.getYjsUpdateLog()
    table.setViewPolicy({ allowExport: false, watermark: { viewerText: 'U-42' } })
    table.setViewPolicy({})
    return { denied, allowedBefore, snapshot: snapshot.format, updates: updates.updates.length, allowedAfter: table.canExport(), cell: doc.getMap('cells').get('0:0') }
  })
  expect(result).toEqual({
    denied: ['NotAllowedError', 'NotAllowedError'], allowedBefore: false, snapshot: 'colwork.snapshot',
    updates: 1, allowedAfter: true, cell: 'Host can still save',
  })
  await expect(page.locator(overlaySelector)).toHaveCount(0)
})

test('Vue and React demos honor export settings for both download buttons', async ({ page }) => {
  await page.route('http://127.0.0.1:4444/api/users', route => route.fulfill({
    status: 200, body: '{}', headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' },
  }))
  for (const framework of ['vue', 'react']) {
    await page.goto(`/test/${framework}.html?viewerWatermark=1&fixedWatermark=1&allowExport=0`)
    await expect(page.locator(overlaySelector)).toBeVisible()
    await expect(page.getByRole('button', { name: '导出快照' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '导出更新日志' })).toBeDisabled()
  }
  await page.goto('/test/vue.html')
  await expect(page.locator(viewportSelector)).toBeVisible()
  for (const [name, filename] of [['导出快照', 'colwork.snapshot.json'], ['导出更新日志', 'colwork.update-log.json']]) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name }).click()])
    expect(download.suggestedFilename()).toBe(filename)
  }
})
