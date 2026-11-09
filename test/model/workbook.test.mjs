import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { getSheetMaps, listWorkbookSheets, readSheetSnapshot, setWorkbookSheetName } from '../../dist/model.js'
import { exportXlsx, importXlsx } from '../../dist/xlsx.js'

const arrayBuffer = value => Uint8Array.from(value).buffer

async function sample() {
  const workbook = new ExcelJS.Workbook()
  const first = workbook.addWorksheet('Rates')
  const next = workbook.addWorksheet('Totals')
  first.getCell('A1').value = 12
  first.getCell('A2').value = 8
  first.getCell('B1').value = '0012'
  first.getCell('B2').value = '=literal'
  first.getCell('A1').font = { bold: true, size: 12, color: { argb: 'FF004488' } }
  first.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEDD' } }
  first.getCell('B4').alignment = { horizontal: 'right' }
  first.getRow(1).height = 24
  first.getColumn(1).width = 20
  first.mergeCells('C1:D2')
  next.getCell('A1').value = { formula: 'SUM(Rates!A1:A2)', result: 20 }
  next.getCell('A2').value = { formula: 'SIN(0)', result: 0 }
  return arrayBuffer(await workbook.xlsx.writeBuffer())
}

test('XLSX round trip preserves sheet order, data, formulas, merges, and supported styles', async () => {
  const doc = new Y.Doc()
  try {
    const ids = await importXlsx(doc, await sample(), { replaceBlankMain: true })
    assert.deepEqual(listWorkbookSheets(doc).map(sheet => sheet.name), ['Rates', 'Totals'])
    const first = readSheetSnapshot(doc, {}, ids[0])
    assert.equal(first.cells['0:0'], '12')
    assert.equal(first.cells['0:1'], '0012')
    assert.deepEqual(first.styles['0:0'], { bold: true, fontSize: 16, color: '#004488', background: '#eeeedd' })
    assert.equal(first.styles['3:1'].align, 'right')
    assert.equal(first.rowHeights['0'], 32)
    assert.equal(first.columnWidths['0'], 145)
    assert.deepEqual(first.merges, [{ start: { row: 0, column: 2 }, end: { row: 1, column: 3 } }])
    assert.equal(readSheetSnapshot(doc, {}, ids[1]).cells['0:0'], "=SUM('Rates'!A1:A2)")
    setWorkbookSheetName(doc, ids[0], 'New Rates')
    const output = new ExcelJS.Workbook()
    await output.xlsx.load(arrayBuffer(await exportXlsx(doc)))
    assert.deepEqual(output.worksheets.map(sheet => sheet.name), ['New Rates', 'Totals'])
    assert.equal(output.getWorksheet('New Rates').getCell('B1').value, '0012')
    assert.equal(output.getWorksheet('New Rates').getCell('B2').value, '=literal')
    assert.equal(output.getWorksheet('New Rates').getCell('A1').font.bold, true)
    assert.deepEqual(output.getWorksheet('New Rates').model.merges, ['C1:D2'])
    assert.equal(output.getWorksheet('Totals').getCell('A1').formula, "SUM('New Rates'!A1:A2)")
    assert.equal(output.getWorksheet('Totals').getCell('A1').result, 20)
    assert.equal(output.getWorksheet('Totals').getCell('A2').formula, 'SIN(0)')
  } finally { doc.destroy() }
})

test('imports preserve existing sheets and reject invalid merge sizes before any document write', async () => {
  const input = await sample()
  const doc = new Y.Doc()
  try {
    setWorkbookSheetName(doc, 'main', 'Rates')
    getSheetMaps(doc).cells.set('0:0', 'Keep')
    const ids = await importXlsx(doc, input)
    assert.deepEqual(listWorkbookSheets(doc).map(sheet => sheet.name), ['Rates', 'Rates (2)', 'Totals'])
    assert.equal(readSheetSnapshot(doc).cells['0:0'], 'Keep')
    assert.equal(readSheetSnapshot(doc, {}, ids[1]).cells['0:0'], "=SUM('Rates (2)'!A1:A2)")
    const before = Y.encodeStateAsUpdate(doc)
    await assert.rejects(importXlsx(doc, input, { canApply: () => false }), /导入已取消/)
    const zip = await JSZip.loadAsync(input)
    const entry = zip.file('xl/worksheets/sheet1.xml')
    zip.file(entry.name, (await entry.async('string')).replace('C1:D2', 'A1:XFD99999'))
    await assert.rejects(importXlsx(doc, await zip.generateAsync({ type: 'arraybuffer' })), /合并区域过大/)
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before)
  } finally { doc.destroy() }
})

test('imports valid XLSX parts that use a prefix for SpreadsheetML tags', async () => {
  const zip = await JSZip.loadAsync(await sample())
  for (const entry of zip.file(/^xl\/(workbook\.xml|styles\.xml|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/)) {
    const xml = await entry.async('string')
    zip.file(entry.name, xml.replace(/<(\/?)([A-Za-z][\w.-]*)(?=[\s/>])/g, '<$1m:$2')
      .replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        'xmlns:m="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'))
  }
  const doc = new Y.Doc()
  try {
    const ids = await importXlsx(doc, await zip.generateAsync({ type: 'arraybuffer' }), { replaceBlankMain: true })
    assert.deepEqual(listWorkbookSheets(doc).map(sheet => sheet.name), ['Rates', 'Totals'])
    assert.equal(readSheetSnapshot(doc).cells['0:1'], '0012')
    assert.equal(readSheetSnapshot(doc, {}, ids[1]).cells['0:0'], "=SUM('Rates'!A1:A2)")
  } finally { doc.destroy() }
})
