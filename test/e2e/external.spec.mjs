import { test, expect } from '@playwright/test'

async function mount(page, options = {}) {
  await page.goto('/test/e2e/fixture.html')
  await page.evaluate(async options => {
    const { ColworkTable, Y, Awareness } = await import('/test/e2e/external-fixture.ts')
    window.Y = Y
    window.doc = new Y.Doc()
    window.awareness = new Awareness(doc)
    awareness.setLocalStateField('user', { name: 'Host identity', color: '#dc2626' })
    window.events = []
    doc.on('update', () => events.push({ update: doc.getMap('cells').get('0:0') }))
    const nativeWebSocket = window.WebSocket
    window.networkConnections = 0
    window.WebSocket = class extends nativeWebSocket { constructor(...args) { super(...args); networkConnections++ } }
    const settings = { transport: 'external', collaboration: { document: doc, awareness }, user: 'Fallback identity', rowCount: 20, columnCount: 8,
      onEditingChange: state => events.push({ ...state, value: doc.getMap('cells').get('0:0') }), ...options }
    window.table = new ColworkTable(document.querySelector('#table'), settings)
    const peerRoot = document.createElement('div')
    peerRoot.id = 'peer'
    peerRoot.style.width = '1000px'
    document.body.append(peerRoot)
    window.viewer = new ColworkTable(peerRoot, { ...settings, readOnly: true, onEditingChange: undefined })
    window.WebSocket = nativeWebSocket
  }, options)
}
const cell = (page, key = '0:0', root = '#table') => page.locator(`${root} td[data-key="${key}"]`)
async function draft(page, value) {
  await cell(page).dblclick()
  await page.locator('#table textarea').fill(value)
}

test('external mode is blank, creates no provider, preserves host identity and validates ownership', async ({ page }) => {
  await mount(page)
  expect(await page.evaluate(() => ({ cells: doc.getMap('cells').size, styles: doc.getMap('styles').size, merges: doc.getMap('merges').size,
    network: networkConnections, provider: !!table.provider, user: awareness.getLocalState().user.name })))
    .toEqual({ cells: 0, styles: 0, merges: 0, network: 0, provider: false, user: 'Host identity' })
  await expect(cell(page)).toHaveText('')
  const failures = await page.evaluate(async () => {
    const { ColworkTable } = await import('/src/index.ts')
    const { Awareness } = await import('/test/e2e/external-fixture.ts')
    const other = new Y.Doc()
    const wrongAwareness = new Awareness(other)
    const options = { transport: 'external', collaboration: { document: doc, awareness }, user: 'test' }
    const results = []
    for (const invalid of [{ collaboration: { document: doc, awareness: wrongAwareness } }, { rows: [] }, { snapshot: new Uint8Array() }, { updates: [] }, { initializeAfterSync: true }]) {
      try { new ColworkTable(document.createElement('div'), { ...options, ...invalid }); results.push(false) } catch { results.push(true) }
    }
    wrongAwareness.destroy()
    other.destroy()
    return results
  })
  expect(failures).toEqual([true, true, true, true, true])
})

test('two widgets share live cells, styles and merges while the viewer rejects local edits', async ({ page }) => {
  await mount(page)
  await draft(page, 'Shared value')
  await page.keyboard.press('Enter')
  await expect(cell(page, '0:0', '#peer')).toHaveText('Shared value')
  await cell(page, '0:0', '#peer').dblclick()
  await expect(page.locator('#peer textarea')).toHaveCount(0)
  await expect(page.locator('#peer .colwork-table__toolbar')).toBeHidden()
  await page.evaluate(() => {
    viewer.viewport.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true }))
    doc.getMap('styles').set('0:0', JSON.stringify({ background: '#fef3c7' }))
    doc.getMap('merges').set('1:0-1:1', '1')
    doc.getMap('cells').set('150:0', 'Far remote value')
  })
  await expect(cell(page, '0:0', '#peer')).toHaveCSS('background-color', 'rgb(254, 243, 199)')
  await expect(cell(page, '1:0', '#peer')).toHaveAttribute('colspan', '2')
  expect(await page.evaluate(() => viewer.dimensions.rows)).toBe(151)
  expect(await page.evaluate(() => doc.getMap('cells').get('0:0'))).toBe('Shared value')
})

test('snapshot reads leave drafts untouched and explicit commits notify after Yjs updates', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => doc.getMap('cells').set('0:0', 'Original'))
  await draft(page, 'Uncommitted')
  const before = await page.evaluate(async () => {
    const { readSheetSnapshotUpdate } = await import('/src/model.ts')
    const snapshot = table.getYjsSnapshot()
    const bytes = Uint8Array.from(atob(snapshot.snapshot), value => value.charCodeAt(0))
    return { cell: readSheetSnapshotUpdate(bytes).cells['0:0'], editing: !!document.querySelector('textarea'), last: events.at(-1) }
  })
  expect(before).toEqual({ cell: 'Original', editing: true, last: { editing: true, dirty: true, value: 'Original' } })
  await page.evaluate(() => table.commitEditing())
  await expect(cell(page)).toHaveText('Uncommitted')
  const lastEvents = await page.evaluate(() => events.slice(-2))
  expect(lastEvents).toEqual([{ update: 'Uncommitted' }, { editing: false, dirty: false, value: 'Uncommitted' }])
  await draft(page, 'Discard this')
  await page.evaluate(() => { doc.getMap('cells').set('0:0', 'Remote update'); table.cancelEditing() })
  await expect(cell(page)).toHaveText('Remote update')
})

test('external teardown discards a pending draft and keeps host documents and other widgets alive', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => {
    window.destroyedResources = 0
    doc.on('destroy', () => destroyedResources++)
    awareness.on('destroy', () => destroyedResources++)
    doc.getMap('cells').set('0:0', 'Original')
  })
  await draft(page, 'Must never return')
  await page.evaluate(() => { doc.getMap('cells').clear(); table.destroy(); table.destroy() })
  expect(await page.evaluate(() => ({ size: doc.getMap('cells').size, destroyedResources, last: events.at(-1) })))
    .toEqual({ size: 0, destroyedResources: 0, last: { editing: false, dirty: false, value: undefined } })
  await page.evaluate(() => doc.getMap('cells').set('0:0', 'Host still connected'))
  await expect(cell(page, '0:0', '#peer')).toHaveText('Host still connected')
})

test('readonly changes discard pending inputs, keep live updates and cancel in-flight password actions', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => doc.getMap('cells').set('0:0', 'Original'))
  await draft(page, 'Discard')
  await page.evaluate(() => table.setReadOnly(true))
  await expect(page.locator('#table textarea')).toHaveCount(0)
  await expect(cell(page)).toHaveText('Original')
  await page.evaluate(() => doc.getMap('cells').set('0:0', 'Remote readonly update'))
  await expect(cell(page)).toHaveText('Remote readonly update')
  await page.evaluate(async () => {
    table.setReadOnly(false)
    table.selection.selectRange({ row: 0, column: 0 }, { row: 0, column: 0 })
    const pending = table.setSelectionLocked(true, 'password')
    table.setReadOnly(true)
    table.setReadOnly(false)
    await pending
  })
  expect(await page.evaluate(() => doc.getMap('locks').size)).toBe(0)
  await draft(page, 'Editing restored')
  await page.keyboard.press('Enter')
  await expect(cell(page)).toHaveText('Editing restored')
})

test('Awareness cleanup respects last active widget and later host field writes', async ({ page }) => {
  await mount(page)
  await cell(page).click()
  await cell(page, '0:1', '#peer').click()
  await page.evaluate(() => { window.currentSelection = awareness.getLocalState().selection; table.destroy() })
  expect(await page.evaluate(() => awareness.getLocalState().selection === currentSelection)).toBe(true)
  await page.evaluate(() => {
    awareness.setLocalStateField('selection', { host: true })
    awareness.setLocalStateField('cursor', { host: true })
    awareness.setLocalStateField('editing', 'host-owned')
    viewer.destroy()
  })
  expect(await page.evaluate(() => awareness.getLocalState())).toEqual({ user: { name: 'Host identity', color: '#dc2626' }, selection: { host: true }, cursor: { host: true }, editing: 'host-owned' })
})

test('readonly widgets render remote Awareness selections and leave host presence available after destroy', async ({ page }) => {
  await mount(page)
  await page.evaluate(async () => {
    const { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } = await import('/test/e2e/external-fixture.ts')
    const remoteDoc = new Y.Doc()
    const remote = new Awareness(remoteDoc)
    remote.setLocalState({ user: { name: 'Remote user', color: '#16a34a' }, selection: { anchor: { row: 0, column: 0 }, focus: { row: 1, column: 1 } } })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), 'host-provider')
    remote.destroy()
    remoteDoc.destroy()
  })
  await expect(page.locator('#peer .colwork-table__remote-selection').first()).toBeVisible()
  await expect(page.locator('#peer .colwork-table__remote-cursor').first()).toHaveText('Remote user')
  await cell(page).click()
  await page.evaluate(() => table.destroy())
  expect(await page.evaluate(() => ({ user: awareness.getLocalState().user.name, selection: awareness.getLocalState().selection, cursor: awareness.getLocalState().cursor })))
    .toEqual({ user: 'Host identity', selection: undefined, cursor: undefined })
})

test('external undo tracks widget edits and formatting while preserving host transactions', async ({ page }) => {
  await mount(page)
  await draft(page, 'Local edit')
  await page.keyboard.press('Enter')
  await page.evaluate(() => doc.getMap('cells').set('0:1', 'Host transaction'))
  await page.locator('#table .colwork-table__viewport').focus()
  await page.keyboard.press('Control+z')
  await expect(cell(page)).toHaveText('')
  await expect(cell(page, '0:1')).toHaveText('Host transaction')
  await cell(page).click()
  await page.locator('#table button[title="加粗"]').click()
  await expect(cell(page)).toHaveCSS('font-weight', '700')
  await page.locator('#table .colwork-table__viewport').focus()
  await page.keyboard.press('Control+z')
  await expect(cell(page)).toHaveCSS('font-weight', '400')
})

test('a ten-million-cell merge opens and scrolls with bounded DOM fragments anchored to its source', async ({ page }) => {
  await mount(page)
  const opening = await page.evaluate(() => {
    const started = performance.now()
    doc.transact(() => {
      doc.getMap('cells').set('0:0', 'Huge merge source')
      doc.getMap('styles').set('0:0', JSON.stringify({ bold: true, background: '#fef3c7' }))
      doc.getMap('merges').set('0:0-9999:999', '1')
    })
    return { duration: performance.now() - started, rows: table.table.querySelectorAll('tr').length, cells: table.table.querySelectorAll('td').length }
  })
  expect(opening.duration).toBeLessThan(2000)
  expect(opening.rows).toBeLessThan(50)
  expect(opening.cells).toBeLessThan(1000)
  await expect(cell(page)).toHaveText('Huge merge source')
  await expect(cell(page)).toHaveCSS('font-weight', '700')
  await page.evaluate(() => { table.viewport.scrollTop = 250000; table.viewport.scrollLeft = 90000 })
  await expect.poll(() => cell(page).getAttribute('data-render-row')).not.toBe('0')
  const scrolled = await page.evaluate(() => {
    const source = table.table.querySelector('td[data-key="0:0"]')
    return { rows: table.table.querySelectorAll('tr').length, cells: table.table.querySelectorAll('td').length, rowSpan: source.rowSpan, columnSpan: source.colSpan }
  })
  expect(scrolled.rows).toBeLessThan(50)
  expect(scrolled.cells).toBeLessThan(1000)
  expect(scrolled.rowSpan).toBeLessThan(50)
  expect(scrolled.columnSpan).toBeLessThan(30)
  await expect(cell(page)).toHaveText('Huge merge source')
  await cell(page).dblclick()
  await page.locator('#table textarea').fill('Edited original source')
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => [...doc.getMap('cells')])).toEqual([['0:0', 'Edited original source']])
  expect(await page.evaluate(() => {
    const first = table.sheet.getMergeRanges()
    const reused = first === table.sheet.getMergeRanges()
    doc.getMap('merges').delete('0:0-9999:999')
    return { reused, invalidated: table.sheet.getMergeRanges() !== first }
  })).toEqual({ reused: true, invalidated: true })
})

test('tiny persisted dimensions retain their values while visible rows, columns and merge fragments stay bounded', async ({ page }) => {
  await mount(page)
  const measured = await page.evaluate(() => {
    const started = performance.now()
    doc.transact(() => {
      for (let row = 0; row < 10000; row++) doc.getMap('rowHeights').set(String(row), 0.01)
      for (let column = 0; column < 1000; column++) doc.getMap('columnWidths').set(String(column), 0.01)
      doc.getMap('cells').set('0:0', 'Tiny dimensions source')
      doc.getMap('merges').set('0:0-9999:999', '1')
    })
    return { duration: performance.now() - started, rows: table.table.querySelectorAll('tr').length, cells: table.table.querySelectorAll('td').length,
      storedHeight: doc.getMap('rowHeights').get('0'), storedWidth: doc.getMap('columnWidths').get('0'), height: table.getRowHeight(0), width: table.getColumnWidth(0) }
  })
  expect(measured.duration).toBeLessThan(2000)
  expect(measured.rows).toBeLessThan(80)
  expect(measured.cells).toBeLessThan(2000)
  expect(measured).toMatchObject({ storedHeight: 0.01, storedWidth: 0.01, height: 28, width: 64 })
  await page.evaluate(() => { table.viewport.scrollTop = 100000; table.viewport.scrollLeft = 20000 })
  await expect.poll(() => cell(page).getAttribute('data-render-row')).not.toBe('0')
  await expect(cell(page)).toHaveText('Tiny dimensions source')
  expect(await page.locator('#table tr').count()).toBeLessThan(80)
  await page.evaluate(() => doc.getMap('merges').clear())
  expect(await page.locator('#table td').count()).toBeLessThan(2000)
})
