import { test, expect } from '@playwright/test'

const cell = (page, side, key) => page.locator(`#${side} td[data-key="${key}"]`)

async function mountPeers(page) {
  await page.goto('/test/e2e/fixture.html')
  await page.evaluate(async () => {
    const { ColworkTable, Y, Awareness } = await import('/test/e2e/external-fixture.ts')
    const { readSheetSnapshot, readSheetSnapshotUpdate, getSheetCellStorageKey } = await import('/src/model.ts')
    const tableRoot = document.querySelector('#table')
    const peerRoot = document.body.appendChild(document.createElement('div'))
    peerRoot.id = 'peer'
    peerRoot.style.width = '1000px'
    const left = new Y.Doc()
    const right = new Y.Doc()
    left.getMap('cells').set('0:0', 'Original')
    left.getMap('cells').set('1:0', 'Next')
    left.getMap('rowHeights').set('0', 80)
    left.getMap('styles').set('0:0', '{"bold":true}')
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    const mount = (root, document) => new ColworkTable(root, {
      transport: 'external', collaboration: { document, awareness: new Awareness(document) },
      user: root.id, rowCount: 12, columnCount: 8,
    })
    window.leftTable = mount(tableRoot, left)
    window.rightTable = mount(peerRoot, right)
    window.exchange = () => {
      const a = Y.encodeStateAsUpdate(left)
      const b = Y.encodeStateAsUpdate(right)
      Y.applyUpdate(left, b)
      Y.applyUpdate(right, a)
    }
    window.sheetState = () => [left, right].map(doc => readSheetSnapshot(doc))
    window.archiveState = () => readSheetSnapshotUpdate(Y.encodeStateAsUpdate(left))
    window.storageKey = key => getSheetCellStorageKey(left, key)
  })
}

async function rowAction(page, side, index, label) {
  await page.locator(`#${side} tbody th`).filter({ hasText: new RegExp(`^${index + 1}$`) }).click({ button: 'right' })
  await page.getByRole('button', { name: label, exact: true }).click()
}

async function writeCell(page, side, key, text) {
  await cell(page, side, key).dblclick()
  const input = page.locator(`#${side} textarea`)
  await input.fill(text)
  await input.press('Enter')
}

test('an insert and an offline edit merge into the original row with its dimensions and style', async ({ page }) => {
  await mountPeers(page)
  await rowAction(page, 'table', 0, '在上方插入 1 行')
  await writeCell(page, 'peer', '0:0', 'Concurrent edit')
  await page.evaluate(() => exchange())
  for (const side of ['table', 'peer']) {
    await expect(cell(page, side, '0:0')).toHaveText('')
    await expect(cell(page, side, '1:0')).toHaveText('Concurrent edit')
    await expect(cell(page, side, '2:0')).toHaveText('Next')
  }
  const [a, b] = await page.evaluate(() => sheetState())
  expect(a).toEqual(b)
  expect(a.rowHeights).toEqual({ '1': 80 })
  expect(a.styles).toEqual({ '1:0': { bold: true } })
  expect(await page.evaluate(() => storageKey('1:0'))).toBe('0:0')
  expect(await page.evaluate(() => archiveState())).toEqual(a)
})

test('simultaneous inserts before the same row both survive, with distinct cell values', async ({ page }) => {
  await mountPeers(page)
  for (const [side, value] of [['table', 'Left inserted'], ['peer', 'Right inserted']]) {
    await rowAction(page, side, 0, '在上方插入 1 行')
    await writeCell(page, side, '0:0', value)
  }
  await page.evaluate(() => exchange())
  const [a, b] = await page.evaluate(() => sheetState())
  expect(a).toEqual(b)
  expect([a.cells['0:0'], a.cells['1:0']].sort()).toEqual(['Left inserted', 'Right inserted'])
  expect(a.cells['2:0']).toBe('Original')
  expect(await page.evaluate(() => archiveState())).toEqual(a)
})

test('deletion hides concurrent edits to the removed row and undo restores that same row', async ({ page }) => {
  await mountPeers(page)
  await rowAction(page, 'table', 0, '删除 1 行')
  await writeCell(page, 'peer', '0:0', 'Updated before delete reached peer')
  await page.evaluate(() => exchange())
  const [a, b] = await page.evaluate(() => sheetState())
  expect(a).toEqual(b)
  expect(a.cells).toEqual({ '0:0': 'Next' })
  expect(a.rowHeights).toEqual({})
  await page.locator('#table button[title="撤销"]').click()
  await page.evaluate(() => exchange())
  await expect(cell(page, 'peer', '0:0')).toHaveText('Updated before delete reached peer')
  await expect(cell(page, 'peer', '1:0')).toHaveText('Next')
})

test('a remote insert preserves the target of a cell draft already being typed', async ({ page }) => {
  await mountPeers(page)
  await rowAction(page, 'table', 0, '在上方插入 1 行')
  await cell(page, 'peer', '0:0').dblclick()
  await page.locator('#peer textarea').fill('Draft during remote insert')
  await page.evaluate(() => { exchange(); exchange() })
  await expect(cell(page, 'table', '0:0')).toHaveText('')
  await expect(cell(page, 'table', '1:0')).toHaveText('Draft during remote insert')
})

test('an insertion survives concurrent deletion of the original row it was inserted before', async ({ page }) => {
  await mountPeers(page)
  await rowAction(page, 'table', 0, '在上方插入 1 行')
  await writeCell(page, 'table', '0:0', 'Inserted before a deleted row')
  await rowAction(page, 'peer', 0, '删除 1 行')
  await page.evaluate(() => exchange())
  const [a, b] = await page.evaluate(() => sheetState())
  expect(a).toEqual(b)
  expect(a.cells).toEqual({ '0:0': 'Inserted before a deleted row', '1:0': 'Next' })
})
