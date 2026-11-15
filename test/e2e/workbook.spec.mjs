import { test, expect } from '@playwright/test'
import ExcelJS from 'exceljs'
import { readFile } from 'node:fs/promises'

const cell = (page, side, key) => page.locator(`#${side} td[data-key="${key}"]`)
const value = (page, side, key) => cell(page, side, key).locator('.colwork-table__cell-value')

async function mountPeers(page, seed = []) {
  await page.goto('/test/e2e/fixture.html')
  await page.evaluate(async seed => {
    const { ColworkWorkbook, getSheetMaps, listWorkbookSheets, setWorkbookSheetName } = await import('/src/index.ts')
    const { Y, Awareness } = await import('/test/e2e/external-fixture.ts')
    const left = new Y.Doc()
    const right = new Y.Doc()
    const root = document.body.appendChild(document.createElement('div'))
    root.id = 'peer'
    root.style.width = '1000px'
    seed.forEach(([key, text]) => getSheetMaps(left).cells.set(key, text))
    const updates = [left, right]
    left.on('update', (update, origin) => { if (origin !== 'peer') Y.applyUpdate(right, update, 'peer') })
    right.on('update', (update, origin) => { if (origin !== 'peer') Y.applyUpdate(left, update, 'peer') })
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left), 'peer')
    for (const [index, id] of ['table', 'peer'].entries()) {
      const doc = updates[index]
      new ColworkWorkbook(document.querySelector('#' + id), { collaboration: { document: doc, awareness: new Awareness(doc) }, user: id })
    }
    window.snapshot = () => Array.from(Y.encodeStateAsUpdate(left))
    window.renameMain = name => setWorkbookSheetName(left, 'main', name)
    window.sheetNames = () => listWorkbookSheets(left).map(sheet => sheet.name)
  }, seed)
}

async function edit(page, side, key, text) {
  await cell(page, side, key).dblclick()
  const input = page.locator(`#${side} textarea`)
  await input.fill(text)
  await input.press('Enter')
}

test('sorting and filtering are local while edits still synchronize to the original row', async ({ page }) => {
  await mountPeers(page, [['0:0', 'Title'], ['0:1', 'Budget'], ['0:2', 'Status'],
    ['1:0', 'Alpha'], ['1:1', '100'], ['1:2', 'open'],
    ['2:0', 'Beta'], ['2:1', '2'], ['2:2', 'open'], ['3:0', 'Gamma'], ['3:1', '5'], ['3:2', 'closed']])
  const before = await page.evaluate(() => snapshot())
  await page.locator('#table').getByRole('button', { name: '排序筛选' }).click()
  const dialog = page.getByRole('dialog', { name: '个人排序筛选' })
  await dialog.getByLabel('排序方向').selectOption('asc')
  await dialog.getByLabel('列', { exact: true }).first().selectOption('1')
  await dialog.getByLabel('保留标题行数').fill('1')
  await dialog.getByRole('button', { name: '添加筛选条件' }).click()
  await dialog.getByLabel('列', { exact: true }).last().selectOption('2')
  await dialog.getByLabel('筛选关键词').fill('open')
  await dialog.getByRole('button', { name: '应用到我的视图' }).click()
  expect(await page.evaluate(() => snapshot())).toEqual(before)
  await expect(value(page, 'table', '1:0')).toHaveText('Beta')
  await expect(value(page, 'table', '2:0')).toHaveText('Alpha')
  await expect(value(page, 'table', '3:0')).toHaveCount(0)
  await expect(value(page, 'peer', '1:0')).toHaveText('Alpha')
  await edit(page, 'table', '1:0', 'Beta edited')
  await expect(value(page, 'peer', '2:0')).toHaveText('Beta edited')
  await page.locator('#peer tbody th').filter({ hasText: /^2$/ }).click({ button: 'right' })
  await page.getByRole('button', { name: '在上方插入 1 行' }).click()
  await expect(value(page, 'table', '1:0')).toHaveText('Beta edited')
  await expect(value(page, 'table', '2:0')).toHaveText('Alpha')
  await expect(value(page, 'table', '3:0')).toHaveCount(0)
})

test('shared worksheets have local active tabs and formulas survive renames and row insertions', async ({ page }) => {
  await mountPeers(page, [['0:1', '5']])
  await page.locator('#table').getByRole('button', { name: '新增工作表' }).click()
  await expect(page.locator('#peer').getByRole('button', { name: '工作表1', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#peer').getByRole('button', { name: '工作表2', exact: true })).toBeVisible()
  await edit(page, 'table', '0:0', "='工作表1'!B1*2")
  await page.locator('#peer').getByRole('button', { name: '工作表2', exact: true }).click()
  await expect(value(page, 'peer', '0:0')).toHaveText('10')
  await edit(page, 'table', '1:0', '=A2+1')
  await expect(value(page, 'peer', '1:0')).toHaveText('#CYCLE!')
  await page.locator('#table').getByRole('button', { name: '工作表1', exact: true }).click()
  await edit(page, 'table', '0:1', '7')
  await expect(value(page, 'peer', '0:0')).toHaveText('14')
  await page.evaluate(() => renameMain('Rates'))
  await page.locator('#table tbody th').filter({ hasText: /^1$/ }).click({ button: 'right' })
  await page.getByRole('button', { name: '在上方插入 1 行' }).click()
  await expect(value(page, 'peer', '0:0')).toHaveText('14')
  await cell(page, 'peer', '0:0').dblclick()
  await expect(page.locator('#peer textarea')).toHaveValue("='Rates'!B2*2")
  await page.locator('#peer textarea').press('Escape')
  await page.locator('#table tbody th').filter({ hasText: /^2$/ }).click({ button: 'right' })
  await page.getByRole('button', { name: '删除 1 行' }).click()
  await expect(value(page, 'peer', '0:0')).toHaveText('#REF!')
})

test('workbook page uploads and downloads actual Excel files in the browser', async ({ page }) => {
  const fixture = new ExcelJS.Workbook()
  const input = fixture.addWorksheet('Imported')
  input.getCell('A1').value = 21
  input.getCell('B1').value = { formula: 'A1*2', result: 42 }
  await page.goto('/test/workbook.html')
  await page.locator('#import').setInputFiles({
    name: 'fixture.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await fixture.xlsx.writeBuffer()),
  })
  await expect(value(page, 'table', '0:1')).toHaveText('42')
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()])
  expect(download.suggestedFilename()).toBe('colwork.xlsx')
  const exported = new ExcelJS.Workbook()
  await exported.xlsx.load(await readFile(await download.path()))
  expect(exported.getWorksheet('Imported').getCell('B1').formula).toBe('A1*2')
  expect(exported.getWorksheet('Imported').getCell('B1').result).toBe(42)
})

test('dragging a tab synchronizes its order without switching the peer tab', async ({ page }) => {
  await mountPeers(page)
  const local = page.locator('#table')
  const peer = page.locator('#peer')
  await local.getByRole('button', { name: '新增工作表' }).click()
  const first = local.getByRole('button', { name: '工作表1', exact: true })
  const second = local.getByRole('button', { name: '工作表2', exact: true })
  await second.dragTo(first, { targetPosition: { x: 2, y: 10 } })
  await expect.poll(() => page.evaluate(() => sheetNames())).toEqual(['工作表2', '工作表1'])
  await expect(peer.locator('.colwork-workbook__tabs button').first()).toHaveText('工作表2')
  await expect(peer.getByRole('button', { name: '工作表1', exact: true })).toHaveAttribute('aria-pressed', 'true')
})
