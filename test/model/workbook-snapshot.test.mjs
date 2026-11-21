import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  addWorkbookSheet, compareWorkbookSnapshots, getSheetFeatureMaps, getSheetMaps, listWorkbookSheets, moveWorkbookSheet,
  readSheetSnapshot, readWorkbookSnapshot, readWorkbookSnapshotUpdate, removeWorkbookSheet,
  restoreWorkbookVersion, setWorkbookSheetName, validateWorkbook,
} from '../../dist/model.js'

const copy = doc => {
  const peer = new Y.Doc()
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
  return peer
}
const exchange = (a, b) => {
  const left = Y.encodeStateAsUpdate(a)
  const right = Y.encodeStateAsUpdate(b)
  Y.applyUpdate(a, right)
  Y.applyUpdate(b, left)
}

test('restoring before a sheet existed keeps its retained roots registered across reload', () => {
  const doc = new Y.Doc()
  try {
    getSheetMaps(doc).cells.set('0:0', 'Original')
    doc.getMap('host').set('owner', 'account')
    const before = Y.encodeStateAsUpdate(doc)
    const later = addWorkbookSheet(doc, 'Later')
    getSheetMaps(doc, later).cells.set('0:0', 'Later cell')
    doc.getMap('host').set('owner', 'updated')
    restoreWorkbookVersion(doc, before)
    const restored = copy(doc)
    try {
      assert.deepEqual(validateWorkbook(restored, { allowUnknownRoots: true, maxSheets: 1 }), [])
      assert.deepEqual(readWorkbookSnapshot(restored, { allowUnknownRoots: true }).sheets.map(sheet => sheet.id), ['main'])
      assert.equal(restored.getMap('colwork-workbook').get(later), null)
      assert.equal(restored.getMap('host').get('owner'), 'updated')
    } finally { restored.destroy() }
  } finally { doc.destroy() }
})

test('hosts can limit visible sheets independently of retained sheet records', () => {
  const doc = new Y.Doc()
  try {
    const extra = addWorkbookSheet(doc, 'Extra', { maxSheets: 2 })
    assert.throws(() => addWorkbookSheet(doc, 'Overflow', { maxSheets: 2 }), /最多允许 2 张/)
    removeWorkbookSheet(doc, extra)
    assert.deepEqual(validateWorkbook(doc, { maxSheets: 1 }), [])
    assert.ok(validateWorkbook(doc, { maxRegisteredSheets: 1 }).some(issue => issue.message.includes('maxRegisteredSheets')))
    addWorkbookSheet(doc, 'New', { maxSheets: 2 })
    assert.equal(listWorkbookSheets(doc).length, 2)
  } finally { doc.destroy() }
})

test('concurrent reorders keep one layout and retain concurrently added tabs', () => {
  const left = new Y.Doc()
  const b = addWorkbookSheet(left, 'Second')
  const c = addWorkbookSheet(left, 'Third')
  const right = copy(left)
  try {
    moveWorkbookSheet(left, c, 'main')
    moveWorkbookSheet(right, b, 'main')
    const added = addWorkbookSheet(right, 'New from peer')
    exchange(left, right)
    assert.deepEqual(validateWorkbook(left), [])
    const snapshot = readWorkbookSnapshot(left)
    assert.deepEqual(snapshot, readWorkbookSnapshot(right))
    assert.deepEqual(new Set(snapshot.sheets.map(sheet => sheet.id)), new Set(['main', b, c, added]))
    assert.equal(left.getArray('colwork-workbook-order').length, 3)
    const layout = left.getMap('colwork-workbook-layout').get('order')
    assert.equal(layout.length, new Set(layout).size)

    // Legacy arrays could have duplicates after an offline reordering conflict.
    const legacy = new Y.Doc()
    try {
      const id = addWorkbookSheet(legacy, 'Legacy')
      legacy.getArray('colwork-workbook-order').push(['main', id, id])
      assert.deepEqual(validateWorkbook(legacy), [])
      assert.deepEqual(readWorkbookSnapshot(legacy).sheets.map(sheet => sheet.id), ['main', id])
    } finally { legacy.destroy() }
  } finally { left.destroy(); right.destroy() }
})

test('simultaneous deletion of both tabs still gives a persistent fallback when adding another', () => {
  const left = new Y.Doc()
  const id = addWorkbookSheet(left, 'Another')
  const right = copy(left)
  try {
    removeWorkbookSheet(left, 'main')
    removeWorkbookSheet(right, id)
    exchange(left, right)
    assert.deepEqual(readWorkbookSnapshot(left).sheets.map(sheet => sheet.id), ['main'])
    const next = addWorkbookSheet(left, 'After deletion')
    assert.deepEqual(readWorkbookSnapshot(left).sheets.map(sheet => sheet.id), ['main', next])
  } finally { left.destroy(); right.destroy() }
})

test('canonical snapshots resolve concurrent overlap while legacy strict readers still reject it', () => {
  const left = new Y.Doc(), right = new Y.Doc()
  try {
    const horizontal = { start: { row: 0, column: 0 }, end: { row: 0, column: 2 } }
    getSheetMaps(left).merges.set('0:0-0:2', '1')
    getSheetMaps(right).merges.set('0:1-1:1', '1')
    getSheetMaps(right).merges.set('1:0-1:2', '1')
    exchange(left, right)
    assert.deepEqual(validateWorkbook(left), [])
    assert.throws(() => readSheetSnapshot(left), /must not overlap/)
    const snapshot = readWorkbookSnapshot(left)
    assert.deepEqual(snapshot.sheets[0].snapshot.merges, [
      horizontal, { start: { row: 1, column: 0 }, end: { row: 1, column: 2 } },
    ])
    assert.deepEqual(snapshot, readWorkbookSnapshot(right))
    assert.deepEqual(snapshot, readWorkbookSnapshotUpdate(Y.encodeStateAsUpdate(left)))
    assert.throws(() => readWorkbookSnapshot(left, { mergeConflicts: 'reject' }), /must not overlap/)
  } finally { left.destroy(); right.destroy() }
})

test('workbook metadata, removed sheets, feature-only changes and full-document limits are validated', () => {
  const doc = new Y.Doc()
  try {
    const extra = addWorkbookSheet(doc, 'Extra')
    const cells = getSheetMaps(doc, extra).cells
    cells.set('0:0', 'Before')
    moveWorkbookSheet(doc, extra, 'main')
    const version = Y.encodeStateAsUpdate(doc)
    const before = readWorkbookSnapshot(doc)
    const feature = getSheetFeatureMaps(doc, extra)
    feature.validation.set('0:0-0:0', JSON.stringify({ choices: ['Before', 'After'] }))
    assert.equal(compareWorkbookSnapshots(before, readWorkbookSnapshot(doc))[0].rules.count, 1)
    cells.set('0:0', 'After')
    setWorkbookSheetName(doc, extra, 'Renamed')
    moveWorkbookSheet(doc, 'main', extra)
    const changes = compareWorkbookSnapshots(before, readWorkbookSnapshot(doc), { maxExamples: 1 })
    const change = changes.find(sheet => sheet.id === extra)
    assert.equal(change.previousName, 'Extra')
    assert.equal(change.moved, true)
    assert.deepEqual(change.cells, { count: 1, examples: [{ key: '0:0', before: 'Before', after: 'After' }] })
    assert.deepEqual(change.rules, { count: 1, examples: [], precedenceChanged: false })
    assert.ok(validateWorkbook(doc, { maxEntries: 2 }).some(issue => issue.message.includes('maxEntries')))
    assert.ok(validateWorkbook(doc, { maxSheets: 1 }).some(issue => issue.message.includes('maxSheets')))
    restoreWorkbookVersion(doc, version)
    assert.deepEqual(readWorkbookSnapshot(doc), before)

    const invalid = 'ffffffffffffffffffffffffffffffff'
    doc.getMap(`colwork-sheet:${invalid}:cells`).set('0:0', 'Orphan')
    assert.ok(validateWorkbook(doc).some(issue => issue.message === 'Sheet has no workbook entry'))
    doc.share.delete(`colwork-sheet:${invalid}:cells`)
    removeWorkbookSheet(doc, extra)
    getSheetMaps(doc, extra).styles.set('0:0', 'malformed')
    assert.ok(validateWorkbook(doc).some(issue => issue.path === `sheets.${extra}.styles.0:0`))
  } finally { doc.destroy() }
})

test('whole-workbook validation rejects malformed ordering while ignoring opted-in host roots', () => {
  const doc = new Y.Doc()
  try {
    doc.getMap('host').set('owner', 'account')
    assert.ok(validateWorkbook(doc).some(issue => issue.path === 'host'))
    assert.deepEqual(validateWorkbook(doc, { allowUnknownRoots: true }), [])
    doc.getMap('colwork-workbook-layout').set('order', ['main', 'main', 'missing'])
    const issues = validateWorkbook(doc, { allowUnknownRoots: true })
    assert.deepEqual(issues.map(issue => issue.path), ['colwork-workbook-layout.order.1', 'colwork-workbook-layout.order.2'])
  } finally { doc.destroy() }
})
