import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { getSheetFeatureMaps, getSheetMaps, listWorkbookSheets, readSheetSnapshot, setWorkbookSheetName } from '../../dist/model.js'
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

test('XLSX checks the host limit against both existing and imported sheets', async () => {
  const doc = new Y.Doc()
  try {
    const input = await sample()
    await assert.rejects(importXlsx(doc, input, { maxSheets: 2 }), /最多允许 2 张/)
    assert.deepEqual(listWorkbookSheets(doc).map(sheet => sheet.id), ['main'])
    await importXlsx(doc, input, { maxSheets: 2, replaceBlankMain: true })
    assert.equal(listWorkbookSheets(doc).length, 2)
    const fallback = new Y.Doc()
    try {
      fallback.getMap('colwork-workbook').set('main', null)
      getSheetMaps(fallback).cells.set('0:0', 'Fallback content')
      await importXlsx(fallback, input)
      assert.equal(listWorkbookSheets(fallback).length, 3)
      assert.equal(readSheetSnapshot(fallback).cells['0:0'], 'Fallback content')
    } finally { fallback.destroy() }
  } finally { doc.destroy() }
})

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

test('Excel warns before uploading images or writing detected losses and lets the host cancel', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Advanced')
  sheet.getCell('A1').value = 12
  sheet.getCell('B2').dataValidation = { type: 'whole', operator: 'between', formulae: [1, 10] }
  sheet.addConditionalFormatting({ ref: 'A1', rules: [{ type: 'expression', formulae: ['A1>10'], priority: 1,
    style: { font: { bold: true } } }] })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6CYAAAAASUVORK5CYII=', 'base64')
  sheet.addImage(workbook.addImage({ extension: 'png', buffer: png }), 'C1:C1')
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
  const manifest = await zip.file('[Content_Types].xml').async('string')
  zip.file('[Content_Types].xml', manifest.replace('</Types>', '<Override PartName="/xl/charts/monthly.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'))
  zip.file('xl/charts/monthly.xml', '<chartSpace/>')
  zip.file('xl/pivotTables/pivotTable1.xml', '<pivotTableDefinition/>')
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  const doc = new Y.Doc()
  try {
    const before = Y.encodeStateAsUpdate(doc)
    const calls = []
    let accept = false
    const options = {
      async confirmWarnings(warnings) {
        calls.push('confirm')
        assert.deepEqual(warnings, [
          { feature: 'charts', count: 1 }, { feature: 'pivotTables', count: 1 },
          { feature: 'dataValidation', sheet: 'Advanced' }, { feature: 'conditionalFormatting', sheet: 'Advanced' },
        ])
        assert.deepEqual(Y.encodeStateAsUpdate(doc), before)
        return accept
      },
      async uploadImage() { calls.push('upload'); return { id: 'approved-image' } },
    }
    await assert.rejects(importXlsx(doc, bytes, options), /已取消导入 Excel/)
    assert.deepEqual(calls, ['confirm'])
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before)
    accept = true
    const [id] = await importXlsx(doc, bytes, options)
    assert.deepEqual(calls, ['confirm', 'confirm', 'upload'])
    assert.equal(readSheetSnapshot(doc, {}, id).cells['0:0'], '12')
  } finally { doc.destroy() }
})

test('Excel picture bytes and common rules round-trip through host image callbacks', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Assets')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6CYAAAAASUVORK5CYII=', 'base64')
  sheet.addImage(workbook.addImage({ extension: 'png', buffer: png }), 'B2:B2')
  sheet.getCell('A1').dataValidation = { type: 'list', formulae: ['"Accepted,Rejected"'], allowBlank: true }
  sheet.addConditionalFormatting({ ref: 'C1:C3', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [5], priority: 1,
    style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEDCBA' } } } }] })
  const doc = new Y.Doc()
  try {
    const [id] = await importXlsx(doc, arrayBuffer(await workbook.xlsx.writeBuffer()), {
      confirmWarnings() { throw new Error('Supported rules should import without a warning') },
      async uploadImage({ bytes, mimeType }) {
        assert.equal(mimeType, 'image/png')
        assert.deepEqual(Buffer.from(bytes), png)
        return { id: 'image-asset-1', alt: 'Attachment' }
      },
    })
    assert.match(readSheetSnapshot(doc, {}, id).cells['1:1'], /image-asset-1/)
    const output = new ExcelJS.Workbook()
    await output.xlsx.load(arrayBuffer(await exportXlsx(doc, { async readImage(image) {
      assert.equal(image.id, 'image-asset-1')
      return { bytes: png, mimeType: 'image/png' }
    } })))
    const restored = output.getWorksheet('Assets')
    assert.deepEqual(restored.getCell('A1').dataValidation.formulae, ['"Accepted,Rejected"'])
    assert.equal(restored.conditionalFormattings[0].rules[0].style.fill.fgColor.argb, 'FFFEDCBA')
    assert.equal(restored.getImages().length, 1)
    assert.deepEqual(output.getImage(restored.getImages()[0].imageId).buffer, png)
  } finally { doc.destroy() }
})

test('Excel export reports omitted features and image fallback before generating a file', async () => {
  const source = new ExcelJS.Workbook()
  const sheet = source.addWorksheet('Export')
  sheet.getCell('A1').value = 'keep'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6CYAAAAASUVORK5CYII=', 'base64')
  sheet.addImage(source.addImage({ extension: 'png', buffer: png }), 'B2:B2')
  const doc = new Y.Doc()
  try {
    const [id] = await importXlsx(doc, arrayBuffer(await source.xlsx.writeBuffer()), {
      replaceBlankMain: true, async uploadImage() { return { id: 'export-asset', alt: '附件说明' } },
    })
    const { analyses, validation } = getSheetFeatureMaps(doc, id)
    const analysis = { name: '预算', range: '0:0-1:1', group: '0', value: '1', summarize: 'sum' }
    analyses.set('a'.repeat(32), JSON.stringify({ ...analysis, kind: 'bar' }))
    analyses.set('b'.repeat(32), JSON.stringify({ ...analysis, kind: 'pivot' }))
    validation.set('0:2-0:2', JSON.stringify({ choices: ['带,逗号'] }))
    getSheetMaps(doc, id).locks.set('0:0', '1')
    const before = Y.encodeStateAsUpdate(doc)
    const readImage = async () => { throw new Error('image not available') }
    await assert.rejects(exportXlsx(doc, { readImage }), /image not available/)
    let allow = false
    const options = { readImage, async confirmWarnings(warnings) {
      assert.deepEqual(warnings.map(({ feature, sheet, count }) => [feature, sheet, count]), [
        ['charts', 'Export', 1], ['pivotTables', 'Export', 1], ['protection', 'Export', 1],
        ['images', 'Export', 1], ['dataValidation', 'Export', 1],
      ])
      return allow
    } }
    await assert.rejects(exportXlsx(doc, options), /已取消导出 Excel/)
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before)
    allow = true
    const output = new ExcelJS.Workbook()
    await output.xlsx.load(arrayBuffer(await exportXlsx(doc, options)))
    const exported = output.getWorksheet('Export')
    assert.equal(exported.getCell('A1').value, 'keep')
    assert.equal(exported.getCell('B2').value, '附件说明')
    assert.equal(exported.getImages().length, 0)
    assert.equal(exported.getCell('C1').dataValidation, undefined)
  } finally { doc.destroy() }
})

test('Excel evaluates conditional sums, counts, and lookup fallbacks during export', async () => {
  const doc = new Y.Doc()
  try {
    const maps = getSheetMaps(doc)
    for (const [key, value] of Object.entries({
      '0:0': 'open', '0:1': '20', '0:2': 'Red',
      '1:0': 'open', '1:1': '2', '1:2': 'Blue',
      '2:0': 'closed', '2:1': '40', '2:2': 'Green',
      '0:3': '=SUMIFS(B1:B3,A1:A3,"open",B1:B3,">5")',
      '1:3': '=COUNTIFS(A1:A3,"o*",B1:B3,">1")',
      '2:3': '=XLOOKUP("closed",A1:A3,C1:C3,"missing")',
      '3:3': '=_xlfn.XLOOKUP("missing",A1:A3,C1:C3,"fallback")',
    })) maps.cells.set(key, value)
    const output = new ExcelJS.Workbook()
    await output.xlsx.load(arrayBuffer(await exportXlsx(doc)))
    assert.deepEqual([1, 2, 3, 4].map(row => output.getWorksheet(1).getCell(`D${row}`).result), [20, 2, 'Green', 'fallback'])
  } finally { doc.destroy() }
})

test('a host restore updates connected peers and preserves host-owned roots', async () => {
  const { addWorkbookSheet, moveWorkbookSheet, restoreWorkbookVersion } = await import('../../dist/model.js')
  const live = new Y.Doc()
  const peer = new Y.Doc()
  try {
    const additional = addWorkbookSheet(live, 'Second')
    moveWorkbookSheet(live, additional, 'main')
    getSheetMaps(live).cells.set('0:0', 'saved value')
    const snapshot = Y.encodeStateAsUpdate(live)
    getSheetMaps(live).cells.set('0:0', 'current value')
    const transient = addWorkbookSheet(live, 'Temporary')
    live.getMap('host-only').set('revision', 45)
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live))
    live.on('update', update => Y.applyUpdate(peer, update))
    restoreWorkbookVersion(live, snapshot)
    assert.deepEqual(listWorkbookSheets(peer).map(sheet => sheet.id), [additional, 'main'])
    assert.equal(getSheetMaps(peer).cells.get('0:0'), 'saved value')
    assert.equal(peer.getMap('host-only').get('revision'), 45)
    assert.equal(listWorkbookSheets(peer).some(sheet => sheet.id === transient), false)
  } finally { live.destroy(); peer.destroy() }
})
