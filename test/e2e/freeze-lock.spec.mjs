import { test, expect } from '@playwright/test'
import { WebSocketServer } from 'ws'
import { createRequire } from 'node:module'
const { setupWSConnection } = createRequire(import.meta.url)('y-websocket/bin/utils')
let server
let websocketUrl

test.beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  server.on('connection', setupWSConnection)
  await new Promise(resolve => server.on('listening', resolve))
  websocketUrl = `ws://127.0.0.1:${server.address().port}`
})
test.afterAll(async () => {
  for (const client of server.clients) client.terminate()
  await new Promise(resolve => server.close(resolve))
})
async function mount(page, room = `test-${Date.now()}`) {
  await page.goto('/test/e2e/fixture.html')
  await page.evaluate(async ({ room, websocketUrl }) => {
    const { ColworkTable } = await import('/src/index.ts')
    window.table = new ColworkTable(document.querySelector('#table'), {
      room, user: 'tester', rowCount: 200, columnCount: 100, websocketUrl,
    })
    // Exercise actual WebSocket synchronization, not same-browser BroadcastChannel.
    table.provider.disconnectBc()
    await new Promise(resolve => table.provider.synced ? resolve() : table.provider.once('sync', resolve))
  }, { room, websocketUrl })
}
const cell = (page, key) => page.locator(`td[data-key="${key}"]`)
async function selectionEdges(page, selector = '.colwork-table__selection') {
  return page.locator(selector).evaluateAll(elements => {
    const boxes = elements.map(element => element.getBoundingClientRect())
    return { left: Math.min(...boxes.map(box => box.left)), top: Math.min(...boxes.map(box => box.top)), right: Math.max(...boxes.map(box => box.right)), bottom: Math.max(...boxes.map(box => box.bottom)) }
  })
}
async function select(page, key) { await cell(page, key).click() }
async function protectionAction(page, label) {
  await page.getByRole('button', { name: '保护', exact: true }).click()
  await page.locator('.colwork-table__context-menu').getByRole('button', { name: `${label}选区`, exact: true }).click()
}

test('selection reaches actual cell edges with merged endpoints, narrow columns, zoom and borders', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => {
    table.columnCountValue = 6
    table.doc.transact(() => { for (let index = 0; index < 6; index++) table.columnWidths.set(String(index), 64) })
    table.selectRange({ row: 5, column: 0 }, { row: 5, column: 2 })
  })
  const checkMerged = async () => {
    const merged = await cell(page, '5:0').boundingBox()
    const overlay = await selectionEdges(page)
    expect(Math.abs(overlay.left - merged.x)).toBeLessThan(0.6)
    expect(Math.abs(overlay.right - merged.x - merged.width)).toBeLessThan(0.6)
    expect(Math.abs(overlay.top - merged.y)).toBeLessThan(0.6)
    expect(Math.abs(overlay.bottom - merged.y - merged.height)).toBeLessThan(0.6)
  }
  await checkMerged()
  await page.evaluate(() => {
    table.viewport.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, cancelable: true }))
    table.toggleBorder('outer')
  })
  await checkMerged()
  await page.evaluate(() => {
    table.setFrozenPanes(2, 3)
    table.selectRange({ row: 0, column: 0 }, { row: 1, column: 4 })
  })
  const first = await cell(page, '0:0').boundingBox()
  const last = await cell(page, '1:4').boundingBox()
  const overlay = await selectionEdges(page)
  expect(Math.abs(overlay.left - first.x)).toBeLessThan(0.6)
  expect(Math.abs(overlay.top - first.y)).toBeLessThan(0.6)
  expect(Math.abs(overlay.right - last.x - last.width)).toBeLessThan(0.6)
  expect(Math.abs(overlay.bottom - last.y - last.height)).toBeLessThan(0.6)
})

test('frozen selection follows native scrolling before the queued virtual render', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => {
    table.setFrozenPanes(2, 3)
    table.selectRange({ row: 0, column: 0 }, { row: 1, column: 2 })
  })
  const differences = await page.evaluate(() => {
    // Delay the expensive virtual render, as can happen during a busy frame.
    const original = window.requestAnimationFrame
    window.requestAnimationFrame = () => 0
    try {
      table.viewport.scrollLeft = 600
      table.viewport.scrollTop = 800
      table.viewport.dispatchEvent(new Event('scroll'))
      const first = document.querySelector('td[data-key="0:0"]').getBoundingClientRect()
      const last = document.querySelector('td[data-key="1:2"]').getBoundingClientRect()
      const boxes = [...document.querySelectorAll('.colwork-table__selection')].map(element => element.getBoundingClientRect())
      return [Math.min(...boxes.map(box => box.left)) - first.left, Math.min(...boxes.map(box => box.top)) - first.top, Math.max(...boxes.map(box => box.right)) - last.right, Math.max(...boxes.map(box => box.bottom)) - last.bottom]
    } finally { window.requestAnimationFrame = original; table.renderFrame = undefined }
  })
  for (const difference of differences) expect(Math.abs(difference)).toBeLessThan(0.6)
})

test('frozen boundary lines stay anchored before scroll handlers or virtual rendering run', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => table.setFrozenPanes(2, 3))
  const changes = await page.evaluate(() => {
    const row = document.querySelector('.colwork-table__frozen-boundary--row')
    const column = document.querySelector('.colwork-table__frozen-boundary--column')
    const beforeRow = row.getBoundingClientRect()
    const beforeColumn = column.getBoundingClientRect()
    // Reproduce compositor scrolling while JavaScript is still busy. No scroll
    // handler or requestAnimationFrame has a chance to correct either line.
    table.viewport.scrollTop = 800
    table.viewport.scrollLeft = 600
    const afterRow = row.getBoundingClientRect()
    const afterColumn = column.getBoundingClientRect()
    return [afterRow.x - beforeRow.x, afterRow.y - beforeRow.y,
      afterColumn.x - beforeColumn.x, afterColumn.y - beforeColumn.y,
      afterRow.width - beforeRow.width, afterColumn.height - beforeColumn.height]
  })
  for (const change of changes) expect(Math.abs(change)).toBeLessThan(0.6)
})

test('local and remote highlights stay attached across frozen panes and header selection modes', async ({ page, browser }, testInfo) => {
  const room = `native-selection-${Date.now()}`
  await mount(page, room)
  const context = await browser.newContext()
  const peer = await context.newPage()
  await mount(peer, room)
  await page.evaluate(() => {
    table.setFrozenPanes(2, 3)
    table.selectRange({ row: 0, column: 0 }, { row: 12, column: 5 })
  })
  await peer.evaluate(() => {
    table.selectCell(1, 1, false)
    table.selectCell(10, 4, true)
    table.refreshSelection()
    table.publishSelection()
  })
  await expect(page.locator('.colwork-table__remote-selection').first()).toBeAttached()
  const gaps = await page.evaluate(() => {
    const original = window.requestAnimationFrame
    window.requestAnimationFrame = () => 0
    try {
      table.viewport.scrollTop = 180
      table.viewport.scrollLeft = 240
      table.viewport.dispatchEvent(new Event('scroll'))
      return [...document.querySelectorAll('.colwork-table__selection, .colwork-table__remote-selection')].flatMap(overlay => {
        const a = overlay.getBoundingClientRect()
        const b = overlay.parentElement.getBoundingClientRect()
        return [a.left - b.left, a.top - b.top, a.right - b.right, a.bottom - b.bottom]
      })
    } finally { window.requestAnimationFrame = original; table.renderFrame = undefined }
  })
  for (const gap of gaps) expect(Math.abs(gap)).toBeLessThan(0.6)
  // Scrolling cells and their highlights must remain beneath the frozen pane.
  const hit = await cell(page, '1:1').evaluate(element => {
    const box = element.getBoundingClientRect()
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('td')?.dataset.key
  })
  expect(hit).toBe('1:1')
  await page.screenshot({ path: testInfo.outputPath('native-frozen-selections.png') })
  for (const mode of ['row', 'column', 'all']) {
    await page.evaluate(mode => {
      table.viewport.scrollTop = 0
      table.viewport.scrollLeft = 0
      if (mode === 'all') table.selectRange({ row: 0, column: 0 }, { row: table.rowCount - 1, column: table.columnCount - 1 }, 'all')
      else table.selectHeaderRange(mode, 1, false)
    }, mode)
    const partialCells = await page.locator('.colwork-table__selection').evaluateAll(overlays => overlays.filter(overlay => {
      const a = overlay.getBoundingClientRect()
      const b = overlay.parentElement.getBoundingClientRect()
      return overlay.parentElement.colSpan === 1 && overlay.parentElement.rowSpan === 1
        && (Math.abs(a.width - b.width) > 0.6 || Math.abs(a.height - b.height) > 0.6)
    }).length)
    expect(partialCells).toBe(0)
    if (mode === 'column') {
      await expect.poll(() => page.evaluate(() => {
        // Read both rectangles in one task; queued virtual rendering must not
        // replace the header between two browser round trips.
        const header = document.querySelector('th[data-selection-axis="column"][data-selection-index="1"]')?.getBoundingClientRect()
        const highlight = document.querySelector('td[data-key="0:0"] .colwork-table__selection')?.getBoundingClientRect()
        return header && highlight ? Math.max(Math.abs(highlight.x - header.x), Math.abs(highlight.width - header.width)) : Infinity
      })).toBeLessThan(0.6)
    }
  }
  await page.evaluate(() => {
    table.merges.set('6:4-8:4', '1')
    table.selectHeaderRange('row', 7, false)
  })
  await expect.poll(() => page.evaluate(() => {
    const header = document.querySelector('th[data-selection-axis="row"][data-selection-index="7"]')?.getBoundingClientRect()
    const highlight = document.querySelector('td[data-key="6:4"] .colwork-table__selection')?.getBoundingClientRect()
    return header && highlight ? Math.max(Math.abs(highlight.y - header.y), Math.abs(highlight.height - header.height)) : Infinity
  })).toBeLessThan(0.6)
  await context.close()
})

test('fixed rows/columns survive virtual scrolling, merges, zoom, and unfreeze', async ({ page }) => {
  await mount(page)
  await select(page, '0:0')
  await page.getByRole('button', { name: '视图', exact: true }).hover()
  await page.getByRole('button', { name: '固定至选中行', exact: true }).click()
  await page.getByRole('button', { name: '固定至选中列', exact: true }).click()
  await page.mouse.move(1100, 800)
  const before = await cell(page, '0:0').boundingBox()
  await page.evaluate(() => { table.viewport.scrollTop = 1800; table.viewport.scrollLeft = 1400 })
  await expect.poll(async () => page.evaluate(() => !!document.querySelector('td[data-key="35:0"]'))).toBe(true)
  const after = await cell(page, '0:0').boundingBox()
  expect(Math.abs(after.x - before.x)).toBeLessThan(1)
  expect(Math.abs(after.y - before.y)).toBeLessThan(1)
  expect(after.width).toBeCloseTo(before.width, 0)
  await expect(page.locator('td[data-key]')).not.toHaveCount(20000)
  expect(await page.locator('td[data-key]').count()).toBeLessThan(600)
  expect(await page.evaluate(() => {
    const header = [...table.table.querySelectorAll('thead th')].find(e => e.textContent === 'A')
    const rect = header.getBoundingClientRect()
    return document.elementFromPoint(rect.x + 20, rect.y + 20)?.closest('th') === header
  })).toBe(true)
  const overlay = await page.locator('.colwork-table__selection').boundingBox()
  expect(Math.abs(overlay.width - after.width)).toBeLessThan(2)
  expect(Math.abs(overlay.height - after.height)).toBeLessThan(2)
  await page.evaluate(() => {
    table.viewport.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, cancelable: true }))
  })
  expect((await cell(page, '0:0').boundingBox()).width).toBeGreaterThan(after.width)
  await page.evaluate(() => table.setFrozenPanes(0, 0))
  await expect(cell(page, '0:0')).toHaveCount(0)
})

test('lock blocks editing, mixed paste, formatting, merges and affected structure; unlock restores editing', async ({ page }) => {
  await mount(page)
  await cell(page, '2:1').dblclick()
  await page.locator('textarea').fill('0.9')
  await page.locator('textarea').press('Enter')
  await select(page, '2:1')
  await protectionAction(page, '锁定')
  await expect(page.getByTitle('撤销', { exact: true })).toBeDisabled()
  await expect(cell(page, '2:1')).toHaveAttribute('aria-readonly', 'true')
  await cell(page, '2:1').dblclick()
  await expect(page.locator('textarea')).toHaveCount(0)
  const result = await page.evaluate(() => {
    const original = table.cells.get('2:1')
    const style = table.styles.get('2:1')
    table.clearSelectionContents(); table.toggleFormat('bold'); table.clearFormatting(); table.setStyle('color', '#ff0000'); table.toggleBorder('outer')
    table.selectRange({ row: 2, column: 0 }, { row: 2, column: 1 })
    table.mergeSelection()
    table.modifyAxis('row', 0, 1)
    table.selectRange({ row: 2, column: 0 }, { row: 2, column: 0 })
    const left = table.cells.get('2:0')
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'changed\tchanged')
    table.viewport.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    table.selectRange({ row: 3, column: 1 }, { row: 3, column: 1 })
    table.selectedKey = '3:1'
    table.clearSelectionContents()
    table.undo()
    return { original, actual: table.cells.get('2:1'), style, actualStyle: table.styles.get('2:1'), left, actualLeft: table.cells.get('2:0'), merged: table.merges.has('2:0-2:1') }
  })
  expect(result.actual).toBe(result.original)
  expect(result.actualStyle).toBe(result.style)
  expect(result.actualLeft).toBe(result.left)
  expect(result.merged).toBe(false)
  await select(page, '2:1')
  await protectionAction(page, '解锁')
  await cell(page, '2:1').dblclick()
  await page.locator('textarea').fill('editable again')
  await page.locator('textarea').press('Enter')
  await expect(cell(page, '2:1')).toHaveText('editable again')
})

test('remote lock cancels pending edit, syncs unlock, and survives snapshot restore', async ({ page, browser }) => {
  const room = `shared-${Date.now()}`
  await mount(page, room)
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const peer = await context.newPage()
  await mount(peer, room)
  await cell(peer, '2:0').dblclick()
  await peer.locator('textarea').fill('uncommitted remote edit')
  await select(page, '2:0')
  await protectionAction(page, '锁定')
  await expect(cell(peer, '2:0')).toHaveAttribute('aria-readonly', 'true')
  await expect(peer.locator('textarea')).toHaveCount(0)
  expect(await peer.evaluate(() => table.cells.get('2:0'))).toBe('125000')
  await page.evaluate(() => table.setFrozenPanes(1, 0))
  expect(await peer.evaluate(() => table.frozenRows)).toBe(0)
  const restored = await page.evaluate(async () => {
    const { ColworkTable } = await import('/src/index.ts')
    const snapshot = Uint8Array.from(atob(table.getYjsSnapshot().snapshot), c => c.charCodeAt(0))
    const root = document.createElement('div'); document.body.append(root)
    const restored = new ColworkTable(root, { room: 'restored', user: 'reader', readOnly: true, snapshot })
    const locked = root.querySelector('td[data-key="2:0"]').getAttribute('aria-readonly')
    const persisted = restored.locks.has('2:0')
    restored.destroy()
    return { locked, persisted }
  })
  expect(restored).toEqual({ locked: 'true', persisted: true })
  await protectionAction(page, '解锁')
  await expect(cell(peer, '2:0')).toHaveAttribute('aria-readonly', 'false')
  await context.close()
})


test('merged locks and blank-cell locks survive update-log rebuild without demo reseeding', async ({ page }) => {
  await mount(page)
  await select(page, '0:0')
  await protectionAction(page, '锁定')
  expect(await page.evaluate(() => ['0:0', '0:1', '0:2'].every(key => table.locks.has(key)))).toBe(true)
  await page.getByRole('button', { name: '拆分', exact: true }).click()
  await expect(cell(page, '0:0')).toHaveAttribute('colspan', '3')
  await protectionAction(page, '解锁')
  const result = await page.evaluate(async () => {
    const { ColworkTable, rebuildYjsSnapshot } = await import('/src/index.ts')
    table.doc.transact(() => { table.cells.clear(); table.styles.clear(); table.merges.clear() })
    table.selectRange({ row: 2, column: 2 }, { row: 2, column: 2 })
    const baseline = table.getYjsSnapshot()
    table.setSelectionLocked(true)
    const snapshot = rebuildYjsSnapshot(JSON.stringify(baseline), JSON.stringify(table.getYjsUpdateLog()))
    const root = document.createElement('div'); document.body.append(root)
    const restored = new ColworkTable(root, {
      room: 'empty-' + Date.now(), user: 'restored', websocketUrl: table.options.websocketUrl,
      snapshot: Uint8Array.from(atob(snapshot.snapshot), c => c.charCodeAt(0)),
    })
    const result = { cells: restored.cells.size, locked: restored.locks.has('2:2'), merges: restored.merges.size }
    restored.destroy()
    return result
  })
  expect(result).toEqual({ cells: 0, locked: true, merges: 0 })
})

test('password dialog validates confirmation and password; verifier uses random salt', async ({ page }) => {
  await mount(page)
  await select(page, '2:0')
  await protectionAction(page, '密码锁定')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => table.locks.size)).toBe(0)
  await protectionAction(page, '密码锁定')
  await dialog.getByLabel('密码', { exact: true }).fill('a long 测试 password')
  await dialog.getByLabel('确认密码', { exact: true }).fill('mismatch')
  await dialog.getByRole('button', { name: '确认锁定' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('两次输入的密码不一致')
  expect(await page.evaluate(() => table.locks.size)).toBe(0)
  await dialog.getByLabel('确认密码', { exact: true }).fill('a long 测试 password')
  await dialog.getByRole('button', { name: '确认锁定' }).click()
  await expect(dialog).toHaveCount(0)
  const record = await page.evaluate(() => table.locks.get('2:0'))
  const parsed = JSON.parse(record)
  expect(await page.evaluate(() => JSON.stringify(table.doc.toJSON()))).not.toContain('a long 测试 password')
  expect(record).not.toContain('password')
  expect(parsed).toMatchObject({ version: 1, algorithm: 'PBKDF2-SHA-256', iterations: 600000 })
  const { pbkdf2Sync } = await import('node:crypto')
  expect(parsed.verifier).toBe(pbkdf2Sync('a long 测试 password', Buffer.from(parsed.salt, 'hex'), 600000, 32, 'sha256').toString('hex'))
  // Ordinary locking cannot downgrade password protection.
  await protectionAction(page, '锁定')
  await expect(page.getByRole('status')).toContainText('请先用原密码解锁')
  await expect(page.getByRole('alertdialog', { name: '操作提示' })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveJSProperty('open', true)
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(await page.evaluate(() => table.locks.get('2:0'))).toBe(record)
  await protectionAction(page, '解锁')
  await dialog.getByLabel('密码', { exact: true }).fill('wrong password')
  await dialog.getByRole('button', { name: '确认解锁' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('密码不正确，选区未解锁')
  expect(await page.evaluate(() => table.locks.get('2:0'))).toBe(record)
  await dialog.getByLabel('密码', { exact: true }).fill('a long 测试 password')
  await dialog.getByRole('button', { name: '确认解锁' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(cell(page, '2:0')).toHaveAttribute('aria-readonly', 'false')
  await page.evaluate(() => table.setSelectionLocked(true, 'a long 测试 password'))
  const second = JSON.parse(await page.evaluate(() => table.locks.get('2:0')))
  expect(second.salt).not.toBe(parsed.salt)
  expect(second.verifier).not.toBe(parsed.verifier)
})

test('password protection syncs and survives snapshot/log rebuild; mixed locks unlock atomically', async ({ page, browser }) => {
  const room = `password-${Date.now()}`
  await mount(page, room)
  await select(page, '2:0')
  await page.evaluate(() => table.setSelectionLocked(true, 'first secret'))
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const peer = await context.newPage()
  await mount(peer, room)
  await expect(cell(peer, '2:0')).toHaveAttribute('aria-readonly', 'true')
  await select(peer, '2:0')
  const wrong = await peer.evaluate(async () => {
    try { await table.setSelectionLocked(false, 'wrong'); return 'unlocked' } catch (error) { return error.message }
  })
  expect(wrong).toContain('密码不正确')
  const restoredResult = await peer.evaluate(async () => {
    const { ColworkTable, rebuildYjsSnapshot } = await import('/src/index.ts')
    const baseline = table.getYjsSnapshot()
    table.selectRange({ row: 2, column: 1 }, { row: 2, column: 1 })
    await table.setSelectionLocked(true, 'second secret')
    const snapshot = rebuildYjsSnapshot(JSON.stringify(baseline), JSON.stringify(table.getYjsUpdateLog()))
    const root = document.createElement('div'); document.body.append(root)
    const restored = new ColworkTable(root, {
      room: 'password-restore-' + Date.now(), user: 'restored', websocketUrl: table.options.websocketUrl,
      snapshot: Uint8Array.from(atob(snapshot.snapshot), c => c.charCodeAt(0)),
    })
    restored.provider.disconnect()
    restored.selectRange({ row: 2, column: 0 }, { row: 2, column: 1 })
    let error
    try { await restored.setSelectionLocked(false, 'first secret') } catch (failure) { error = failure.message }
    const remaining = restored.locks.size
    restored.selectRange({ row: 2, column: 0 }, { row: 2, column: 0 })
    await restored.setSelectionLocked(false, 'first secret')
    restored.selectRange({ row: 2, column: 1 }, { row: 2, column: 1 })
    await restored.setSelectionLocked(false, 'second secret')
    const final = restored.locks.size
    restored.destroy()
    return { error, remaining, final }
  })
  expect(restoredResult).toEqual({ error: '密码不正确，选区未解锁', remaining: 2, final: 0 })
  await select(peer, '2:0')
  await peer.evaluate(() => table.setSelectionLocked(false, 'first secret'))
  await expect(cell(page, '2:0')).toHaveAttribute('aria-readonly', 'false')
  await context.close()
})

test('password operations fail closed on malformed records, concurrent changes, and destroy', async ({ page }) => {
  await mount(page)
  await select(page, '2:0')
  const result = await page.evaluate(async () => {
    const errors = []
    const attempt = async action => { try { await action() } catch (error) { errors.push(error.message) } }
    await attempt(() => table.setSelectionLocked(true, ''))
    table.locks.set('2:0', '{invalid}')
    await attempt(() => table.setSelectionLocked(false, 'any'))
    const malformedKept = table.locks.get('2:0') === '{invalid}'
    table.locks.delete('2:0')
    await table.setSelectionLocked(true, 'old secret')
    const pendingUnlock = table.setSelectionLocked(false, 'old secret')
    table.locks.set('2:0', 'new concurrent lock')
    await attempt(() => pendingUnlock)
    const concurrentKept = table.locks.get('2:0') === 'new concurrent lock'
    table.locks.delete('2:0')
    await table.setSelectionLocked(true, 'delete secret')
    const pendingDelete = table.setSelectionLocked(false, 'delete secret')
    table.cells.delete('2:0') // Pure deletions do not advance a Yjs state vector.
    await attempt(() => pendingDelete)
    table.locks.delete('2:0')
    const pendingLock = table.setSelectionLocked(true, 'new secret')
    table.destroy()
    await pendingLock
    return { errors, malformedKept, concurrentKept, afterDestroy: table.locks.size }
  })
  expect(result.errors).toHaveLength(4)
  expect(result.errors[0]).toContain('不能为空')
  expect(result.errors[1]).toContain('无效')
  expect(result.errors[2]).toContain('已变化')
  expect(result.errors[3]).toContain('已变化')
  expect(result.malformedKept).toBe(true)
  expect(result.concurrentKept).toBe(true)
  expect(result.afterDestroy).toBe(0)
})

test('freeze rejects partial merged row/column collections without expanding existing panes', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => table.setFrozenPanes(1, 0))
  // C alone is only part of A:C, even though the eventual leading prefix is A:C.
  await page.locator('thead th').filter({ hasText: /^C$/ }).click()
  await page.getByRole('button', { name: '视图', exact: true }).hover()
  await page.getByRole('button', { name: '固定至选中列', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('当前选择包含不完整的合并块')
  await expect(page.getByRole('alertdialog', { name: '操作提示' })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveJSProperty('open', true)
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(await page.evaluate(() => [table.frozenRows, table.frozenColumns])).toEqual([1, 0])
  const api = await page.evaluate(() => table.setFrozenPanes(1, 1))
  expect(api).toBe(false)
  await page.getByRole('button', { name: '确定', exact: true }).click()
  expect(await page.evaluate(() => [table.frozenRows, table.frozenColumns])).toEqual([1, 0])
  await page.evaluate(() => {
    table.selectHeaderRange('column', 0, false)
    table.selectHeaderRange('column', 2, true)
    table.freezeSelection('column')
  })
  expect(await page.evaluate(() => [table.frozenRows, table.frozenColumns])).toEqual([1, 3])
  await expect(page.getByRole('status')).toHaveCount(0)
  await page.evaluate(() => {
    table.merges.set('2:4-4:4', '1')
    table.selectHeaderRange('row', 4, false)
    table.freezeSelection('row')
  })
  await expect(page.getByRole('status')).toContainText('当前选择包含不完整的合并块')
  await expect(page.getByRole('alertdialog', { name: '操作提示' })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveJSProperty('open', true)
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(await page.evaluate(() => [table.frozenRows, table.frozenColumns])).toEqual([1, 3])
  expect(await page.evaluate(() => table.setFrozenPanes(3, 3))).toBe(false)
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.evaluate(() => {
    table.selectHeaderRange('row', 2, false)
    table.selectHeaderRange('row', 4, true)
    table.freezeSelection('row')
  })
  expect(await page.evaluate(() => [table.frozenRows, table.frozenColumns])).toEqual([5, 3])
})

test('merge refuses either frozen boundary but allows ranges wholly within one pane', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => table.setFrozenPanes(2, 3))
  const original = await page.evaluate(() => table.getYjsSnapshot().snapshot)
  for (const range of [
    [{ row: 1, column: 3 }, { row: 2, column: 4 }],
    [{ row: 2, column: 2 }, { row: 2, column: 3 }],
    [{ row: 1, column: 2 }, { row: 2, column: 3 }],
  ]) {
    await page.evaluate(([anchor, focus]) => table.selectRange(anchor, focus), range)
    await page.getByRole('button', { name: '合并', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('合并范围同时包含固定和非固定区域')
    await expect(page.getByRole('alertdialog', { name: '操作提示' })).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveJSProperty('open', true)
    await page.getByRole('button', { name: '确定', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    expect(await page.evaluate(() => table.getYjsSnapshot().snapshot)).toBe(original)
    expect(await page.evaluate(() => [table.frozenRows, table.frozenColumns])).toEqual([2, 3])
  }
  await page.evaluate(() => table.selectRange({ row: 1, column: 0 }, { row: 1, column: 1 }))
  await page.getByRole('button', { name: '合并', exact: true }).click()
  await expect(cell(page, '1:0')).toHaveAttribute('colspan', '2')
  await page.evaluate(() => table.selectRange({ row: 3, column: 4 }, { row: 3, column: 5 }))
  await page.getByRole('button', { name: '合并', exact: true }).click()
  await expect(cell(page, '3:4')).toHaveAttribute('colspan', '2')
  await expect(page.getByRole('status')).toHaveCount(0)
})

test('password hatching and frozen styles follow scroll, zoom and remote style updates', async ({ page, browser }, testInfo) => {
  const room = `styles-${Date.now()}`
  await mount(page, room)
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const peer = await context.newPage()
  await mount(peer, room)
  await page.evaluate(() => table.setFrozenPanes(2, 3))
  await peer.evaluate(() => {
    table.selectRange({ row: 1, column: 1 }, { row: 1, column: 1 })
    table.selectedKey = '1:1'
    table.setStyle('background', '#fee2e2')
    table.setStyle('color', '#7c3aed')
    table.setStyle('fontSize', 18)
    table.toggleBorder('outer')
  })
  await expect(cell(page, '1:1')).toHaveCSS('background-color', 'rgb(254, 226, 226)')
  const before = await cell(page, '1:1').boundingBox()
  await peer.evaluate(() => table.setSelectionLocked(true, 'hatching password'))
  await expect(cell(page, '1:1')).toHaveClass(/is-password-locked/)
  const hatch = await cell(page, '1:1').evaluate(element => {
    const style = getComputedStyle(element, '::after')
    return { image: style.backgroundImage, events: style.pointerEvents, top: style.top, bottom: style.bottom }
  })
  expect(hatch.image).toContain('repeating-linear-gradient')
  expect(hatch.image).toContain('0.2')
  expect(hatch.events).toBe('none')
  expect(hatch.top).toBe('0px')
  expect(hatch.bottom).toBe('0px')
  await page.evaluate(() => { table.viewport.scrollTop = 1600; table.viewport.scrollLeft = 1200 })
  await expect.poll(() => page.evaluate(() => !!document.querySelector('td[data-key="35:0"]'))).toBe(true)
  const after = await cell(page, '1:1').boundingBox()
  expect(Math.abs(after.x - before.x)).toBeLessThan(1)
  expect(Math.abs(after.y - before.y)).toBeLessThan(1)
  await expect(cell(page, '1:1')).toHaveCSS('border-top-color', 'rgb(100, 116, 139)')
  await expect(cell(page, '1:1')).toHaveCSS('border-top-width', '2px')
  await expect(cell(page, '1:1')).toHaveCSS('background-color', 'rgb(254, 226, 226)')
  await expect(cell(page, '1:1')).toHaveCSS('color', 'rgb(124, 58, 237)')
  await cell(page, '1:1').click()
  expect(await page.evaluate(() => table.selectionFocus)).toEqual({ row: 1, column: 1 })
  await page.evaluate(() => table.viewport.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, cancelable: true })))
  await expect(cell(page, '1:1')).toHaveCSS('font-size', '19.8px')
  await page.screenshot({ path: testInfo.outputPath('frozen-password-hatching.png') })
  await peer.evaluate(() => table.setSelectionLocked(false, 'hatching password'))
  await expect(cell(page, '1:1')).not.toHaveClass(/is-password-locked/)
  // Formatting changes after freeze must refresh both the style and displayed value.
  await peer.evaluate(() => { table.cells.set('1:1', '0.5'); table.setStyle('format', 'percent') })
  await expect(cell(page, '1:1').locator('.colwork-table__cell-value')).toHaveText('50%')
  await peer.evaluate(() => table.clearFormatting())
  await expect(cell(page, '1:1')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(cell(page, '1:1').locator('.colwork-table__cell-value')).toHaveText('0.5')
  await peer.evaluate(() => {
    table.selectRange({ row: 0, column: 4 }, { row: 2, column: 5 })
    table.mergeSelection()
  })
  await expect(page.getByRole('status')).toContainText('已取消与合并块冲突的固定行列')
  await expect(page.getByRole('alertdialog', { name: '操作提示' })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveJSProperty('open', true)
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(await page.evaluate(() => [table.frozenRows, table.frozenColumns])).toEqual([0, 3])
  await context.close()
})

async function headerPoint(page, axis, index) {
  const rect = await page.locator(`th[data-selection-axis="${axis}"][data-selection-index="${index}"]`).boundingBox()
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}
async function dragHeaders(page, axis, from, to) {
  const start = await headerPoint(page, axis, from)
  const end = await headerPoint(page, axis, to)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 12 })
}
async function headerSelection(page) {
  return page.evaluate(() => ({ mode: table.selectionMode, anchor: table.selectionAnchor, focus: table.selectionFocus }))
}

test('header dragging retains its anchor forward/backward, stops on release, and supports Shift', async ({ page }) => {
  await mount(page)
  await dragHeaders(page, 'row', 1, 4)
  expect(await headerSelection(page)).toEqual({ mode: 'row', anchor: { row: 1, column: 0 }, focus: { row: 4, column: 99 } })
  await expect(page.locator('th.is-selected-header')).toHaveCount(4)
  // Crossing cells must not turn a header drag into a cell selection.
  const rect = await cell(page, '3:1').boundingBox()
  await page.mouse.move(rect.x + 20, rect.y + 20, { steps: 4 })
  expect((await headerSelection(page)).mode).toBe('row')
  const previous = await headerPoint(page, 'row', 0)
  await page.mouse.move(previous.x, previous.y, { steps: 8 })
  expect(await headerSelection(page)).toEqual({ mode: 'row', anchor: { row: 1, column: 0 }, focus: { row: 0, column: 99 } })
  await page.mouse.up()
  const later = await headerPoint(page, 'row', 5)
  await page.mouse.move(later.x, later.y)
  expect((await headerSelection(page)).focus.row).toBe(0)
  await page.keyboard.down('Shift')
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.up('Shift')
  expect(await headerSelection(page)).toEqual({ mode: 'row', anchor: { row: 1, column: 0 }, focus: { row: 5, column: 99 } })
  await dragHeaders(page, 'column', 4, 1)
  expect(await headerSelection(page)).toEqual({ mode: 'column', anchor: { row: 0, column: 4 }, focus: { row: 199, column: 1 } })
  await expect(page.locator('th.is-selected-header')).toHaveCount(4)
  await page.mouse.up()
  // Right-click inside the selection preserves it for range operations.
  const inside = await headerPoint(page, 'column', 2)
  await page.mouse.click(inside.x, inside.y, { button: 'right' })
  expect((await headerSelection(page)).anchor.column).toBe(4)
  expect((await headerSelection(page)).focus.column).toBe(1)
  await expect(page.getByRole('button', { name: '删除 4 列', exact: true })).toBeVisible()
})

test('header drag survives virtual rerender and frozen headers, publishes range, and cancels on blur', async ({ page, browser }) => {
  const room = `header-drag-${Date.now()}`
  await mount(page, room)
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const peer = await context.newPage()
  await mount(peer, room)
  await page.evaluate(() => table.setFrozenPanes(1, 3))
  await dragHeaders(page, 'row', 0, 3)
  await page.evaluate(() => { table.viewport.scrollTop = 1600 })
  await expect(page.locator('th[data-selection-axis="row"][data-selection-index="30"]')).toBeVisible()
  const target = await headerPoint(page, 'row', 30)
  await page.mouse.move(target.x, target.y, { steps: 8 })
  await page.mouse.up()
  expect(await headerSelection(page)).toEqual({ mode: 'row', anchor: { row: 0, column: 0 }, focus: { row: 30, column: 99 } })
  await expect.poll(() => peer.evaluate(() => [...table.awareness.getStates()].filter(([id]) => id !== table.doc.clientID).map(([, state]) => state.selection?.focus.row))).toContain(30)
  await dragHeaders(page, 'column', 0, 3)
  await page.evaluate(() => { table.viewport.scrollLeft = 1400 })
  await expect(page.locator('th[data-selection-axis="column"][data-selection-index="13"]')).toBeVisible()
  const column = await headerPoint(page, 'column', 13)
  await page.mouse.move(column.x, column.y, { steps: 8 })
  expect((await headerSelection(page)).anchor.column).toBe(0)
  expect((await headerSelection(page)).focus.column).toBe(13)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.mouse.up()
  const selected = await headerSelection(page)
  const other = await headerPoint(page, 'column', 1)
  await page.mouse.move(other.x, other.y)
  expect(await headerSelection(page)).toEqual(selected)
  await context.close()
})

test('frozen boundaries follow panes and grouped controls fit desktop and narrow screens', async ({ page }, testInfo) => {
  await mount(page)
  await page.evaluate(() => table.setFrozenPanes(2, 3))
  const horizontal = page.locator('.colwork-table__frozen-boundary--row')
  const vertical = page.locator('.colwork-table__frozen-boundary--column')
  await expect(horizontal).toBeVisible()
  await expect(vertical).toBeVisible()
  await expect(vertical).toHaveCSS('pointer-events', 'none')
  const before = { row: await horizontal.boundingBox(), column: await vertical.boundingBox() }
  await page.evaluate(() => { table.viewport.scrollTop = 1600; table.viewport.scrollLeft = 1400 })
  await expect.poll(() => page.evaluate(() => !!document.querySelector('td[data-key="35:0"]'))).toBe(true)
  expect(Math.abs((await horizontal.boundingBox()).y - before.row.y)).toBeLessThan(1)
  expect(Math.abs((await vertical.boundingBox()).x - before.column.x)).toBeLessThan(1)
  await page.evaluate(() => {
    table.showGridLines = false
    table.viewport.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, cancelable: true }))
  })
  expect((await horizontal.boundingBox()).y).toBeGreaterThan(before.row.y)
  expect((await vertical.boundingBox()).x).toBeGreaterThan(before.column.x)
  await expect(page.locator('.colwork-table__toolbar-row')).toHaveCount(2)
  await expect(page.locator('.colwork-table__toolbar-group')).toHaveCount(7)
  await cell(page, '1:1').click({ button: 'right' })
  const menu = page.locator('.colwork-table__context-menu')
  await expect(menu.getByRole('group')).toHaveCount(4)
  await expect(menu.getByRole('button', { name: '复制', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('button', { name: '清空内容', exact: true })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('organized-desktop.png') })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 700 })
  await page.evaluate(() => { document.querySelector('#table').style.width = '100%'; table.setFrozenPanes(1, 0) })
  await expect.poll(() => horizontal.evaluate(element => Math.round(element.getBoundingClientRect().width) - table.viewport.clientWidth)).toBe(0)
  const overflow = await page.locator('.colwork-table__toolbar').evaluate(toolbar => {
    const bounds = toolbar.getBoundingClientRect()
    return [...toolbar.querySelectorAll('button, select, input')].filter(control => {
      const rect = control.getBoundingClientRect()
      return rect.width > 0 && (rect.left < bounds.left || rect.right > bounds.right)
    }).map(control => control.title || control.textContent)
  })
  expect(overflow).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('organized-mobile.png') })
  await page.setViewportSize({ width: 390, height: 320 })
  await page.evaluate(() => table.showCellContextMenu(innerWidth - 1, innerHeight - 1))
  const bounds = await menu.boundingBox()
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(320)
  await page.keyboard.press('End')
  await expect(menu.getByRole('button', { name: '解锁选区', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.evaluate(() => table.setFrozenPanes(0, 0))
  await expect(page.locator('.colwork-table__frozen-boundary')).toHaveCount(0)
})

test('frozen and unfrozen headers remain resizable and cells remain editable', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => table.setFrozenPanes(2, 3))
  const resize = async (axis, index, delta) => {
    const selector = `th[data-selection-axis="${axis}"][data-selection-index="${index}"] .colwork-table__resize-handle`
    await expect(page.locator(selector)).toBeVisible()
    let handle
    // A queued virtual render can replace a visible header between reads.
    await expect.poll(async () => { handle = await page.locator(selector).boundingBox(); return handle !== null }).toBe(true)
    const x = handle.x + handle.width / 2
    const y = handle.y + handle.height / 2
    const before = await page.evaluate(({ axis, index }) => axis === 'row' ? table.getRowHeight(index) : table.getColumnWidth(index), { axis, index })
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + (axis === 'column' ? delta : 0), y + (axis === 'row' ? delta : 0), { steps: 8 })
    await page.mouse.up()
    const after = await page.evaluate(({ axis, index }) => axis === 'row' ? table.getRowHeight(index) : table.getColumnWidth(index), { axis, index })
    expect(after).toBeCloseTo(before + delta, 0)
  }
  await resize('column', 0, 30)
  await resize('column', 2, 25)
  await resize('row', 0, 20)
  await resize('row', 1, 18)
  await page.evaluate(() => { table.viewport.scrollTop = 1300; table.viewport.scrollLeft = 1000 })
  await expect.poll(() => page.evaluate(() => !!document.querySelector('td[data-key="28:0"]'))).toBe(true)
  await resize('column', 1, 16)
  await resize('row', 1, 12)
  await cell(page, '1:1').dblclick()
  await page.locator('textarea').fill('fixed editable')
  await page.locator('textarea').press('Enter')
  await expect(cell(page, '1:1')).toHaveText('fixed editable')
  await page.evaluate(() => { table.viewport.scrollTop = 0; table.viewport.scrollLeft = 0; table.setFrozenPanes(0, 0) })
  await resize('column', 0, 20)
  await resize('row', 0, 12)
  await cell(page, '1:1').dblclick()
  await page.locator('textarea').fill('unfixed editable')
  await page.locator('textarea').press('Enter')
  await expect(cell(page, '1:1')).toHaveText('unfixed editable')
})

test('protection dropdown groups actions and both lock types use the same overlay', async ({ page }, testInfo) => {
  await mount(page)
  const trigger = page.getByRole('button', { name: '保护', exact: true })
  const menu = page.locator('.colwork-table__context-menu')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(menu.getByRole('button')).toHaveText(['锁定选区', '密码锁定选区', '解锁选区'])
  await trigger.click()
  await expect(menu).toHaveCount(0)
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('button', { name: '锁定选区', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await select(page, '2:0')
  await protectionAction(page, '锁定')
  await select(page, '2:1')
  await protectionAction(page, '密码锁定')
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('密码', { exact: true }).fill('same-visual')
  await dialog.getByLabel('确认密码', { exact: true }).fill('same-visual')
  await dialog.getByRole('button', { name: '确认锁定', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const overlay = key => cell(page, key).evaluate(element => {
    const style = getComputedStyle(element, '::after')
    return { image: style.backgroundImage, inset: style.inset, pointerEvents: style.pointerEvents, content: style.content }
  })
  expect(await overlay('2:0')).toEqual(await overlay('2:1'))
  expect((await overlay('2:0')).image).toContain('repeating-linear-gradient')
  for (const key of ['2:0', '2:1']) {
    await expect(cell(page, key)).toHaveAttribute('aria-readonly', 'true')
    await cell(page, key).dblclick()
    await expect(page.locator('textarea')).toHaveCount(0)
  }
  await trigger.click()
  await page.screenshot({ path: testInfo.outputPath('unified-protection.png') })
  await cell(page, '3:1').click()
  await expect(menu).toHaveCount(0)
})
