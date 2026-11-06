import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { COLWORK_SCHEMA_VERSION, COLWORK_MAP_NAMES, getSheetMaps, initializeBlankSheet, validateSheetDocument, readSheetSnapshot, readSheetSnapshotUpdate, exportYjsSnapshot } from '../../dist/model.js'

function documentTest(name, run) {
  test(name, async () => {
    const document = new Y.Doc()
    try { await run(document, getSheetMaps(document)) } finally { document.destroy() }
  })
}

documentTest('blank initialization and the Node ESM/CJS model have no browser dependencies', doc => {
  assert.equal(typeof globalThis.document, 'undefined')
  assert.equal(COLWORK_SCHEMA_VERSION, 1)
  assert.equal(COLWORK_MAP_NAMES.cells, 'cells')
  initializeBlankSheet(doc)
  initializeBlankSheet(doc)
  assert.deepEqual(validateSheetDocument(doc), [])
  const snapshot = readSheetSnapshot(doc)
  assert.deepEqual(snapshot, { schemaVersion: 1, rowCount: 1, columnCount: 1, cells: {}, styles: {}, rowHeights: {}, columnWidths: {}, merges: [], locks: {} })
  assert.equal(doc.getMap('colwork-metadata').get('initialized'), true)
  const output = execFileSync(process.execPath, ['-e', "console.log(require('./dist/model.cjs').COLWORK_SCHEMA_VERSION)"], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' })
  assert.equal(output.trim(), '1')
})

documentTest('canonical reads sort coordinates, style keys and merge ranges and exclude archive metadata', (doc, maps) => {
  maps.cells.set('10:2', 'B')
  maps.cells.set('2:10', 'A😀')
  maps.styles.set('2:10', JSON.stringify({ border: { left: true, top: true }, background: '#fff', bold: false }))
  maps.merges.set('10:2-11:3', '1')
  maps.merges.set('1:1-1:2', '1')
  maps.rowHeights.set('20', 72)
  maps.columnWidths.set('30', 160)
  maps.locks.set('2:10', '1')
  const first = readSheetSnapshot(doc)
  maps.styles.set('2:10', JSON.stringify({ bold: false, background: '#fff', border: { top: true, left: true } }))
  assert.equal(JSON.stringify(first), JSON.stringify(readSheetSnapshot(doc)))
  assert.deepEqual(Object.keys(first.cells), ['2:10', '10:2'])
  assert.equal(first.rowCount, 21)
  assert.equal(first.columnCount, 31)
  const exported = exportYjsSnapshot(doc, { room: 'host archive metadata', sequence: 7 })
  assert.equal(exported.format, 'colwork.snapshot')
  assert.equal(exported.sequence, 7)
  assert.equal(exported.room, 'host archive metadata')
  assert.deepEqual(readSheetSnapshotUpdate(Buffer.from(exported.snapshot, 'base64')), first)
  assert.throws(() => initializeBlankSheet(doc), /empty sheet/)
  assert.throws(() => exportYjsSnapshot(doc, { sequence: -1 }), RangeError)
})

documentTest('host limits bound all coordinate maps, merges, entry totals and wire strings', (doc, maps) => {
  const limits = { maxRows: 10, maxColumns: 5, maxEntries: 50, maxStringLength: 80 }
  for (const name of ['cells', 'styles', 'locks']) {
    maps[name].set('10:0', name === 'cells' ? '' : name === 'styles' ? '{}' : '1')
    assert.ok(validateSheetDocument(doc, limits).some(issue => issue.path.startsWith(name)))
    maps[name].clear()
  }
  maps.rowHeights.set('10', 20)
  maps.columnWidths.set('5', 20)
  maps.merges.set('0:0-10:1', '1')
  assert.equal(validateSheetDocument(doc, limits).length, 3)
  maps.rowHeights.clear(); maps.columnWidths.clear(); maps.merges.clear()
  maps.cells.set('0:0', 'x'.repeat(81))
  assert.match(validateSheetDocument(doc, limits)[0].message, /maxStringLength/)
  assert.match(validateSheetDocument(doc, { maxEntries: 0 })[0].message, /maxEntries/)
  assert.throws(() => readSheetSnapshot(doc, limits), /Invalid Colwork/)
  assert.throws(() => validateSheetDocument(doc, { maxRows: -1 }), RangeError)
})

documentTest('strict wire schema rejects extra roots, nested values, invalid styles and metadata', (doc, maps) => {
  doc.getMap('host-root').set('x', 1)
  assert.match(validateSheetDocument(doc)[0].message, /Unknown/)
  assert.deepEqual(validateSheetDocument(doc, { allowUnknownRoots: true }), [])
  maps.cells.set('0:0', new Y.Map())
  assert.ok(validateSheetDocument(doc).some(issue => issue.path === 'cells.0:0'))
  maps.cells.clear()
  for (const style of [null, [], { unknown: true }, { bold: 'true' }, { fontSize: 0 }, { border: { unknown: true } }, { align: 'invalid' }, { align: ['left'] }, { format: ['general'] }]) {
    maps.styles.set('0:0', JSON.stringify(style))
    assert.ok(validateSheetDocument(doc).some(issue => issue.path === 'styles.0:0'))
  }
  maps.styles.clear()
  doc.getMap('colwork-metadata').set('unknown', true)
  assert.ok(validateSheetDocument(doc).some(issue => issue.path === 'metadata.unknown'))
})

test('Yjs text/array/XML sequence updates cannot hide inside pre-materialized map roots', () => {
  for (const kind of ['text', 'array', 'xml']) {
    const source = new Y.Doc()
    const target = new Y.Doc()
    try {
      getSheetMaps(target)
      if (kind === 'text') source.getText('cells').insert(0, 'hidden text')
      if (kind === 'array') source.getArray('cells').insert(0, [{ embed: true }])
      if (kind === 'xml') source.getXmlFragment('cells').insert(0, [new Y.XmlElement('p')])
      Y.applyUpdate(target, Y.encodeStateAsUpdate(source))
      assert.ok(validateSheetDocument(target).some(issue => issue.path === 'cells'), kind)
      assert.throws(() => readSheetSnapshotUpdate(Y.encodeStateAsUpdate(source)), /Invalid Colwork/)
    } finally { source.destroy(); target.destroy() }
  }
})

documentTest('merge overlap checks distinguish touching edges and validate stored encoding', (doc, maps) => {
  maps.merges.set('0:0-1:1', '1')
  maps.merges.set('2:0-2:1', '1')
  maps.merges.set('0:2-1:2', '1')
  assert.deepEqual(validateSheetDocument(doc), [])
  maps.merges.set('1:1-3:3', '1')
  assert.ok(validateSheetDocument(doc).some(issue => issue.message.includes('overlap')))
  maps.merges.clear()
  for (const key of ['1:0-0:1', '-1:0-0:1', '0:0-9007199254740991:0']) {
    maps.merges.set(key, '1')
    assert.ok(validateSheetDocument(doc).some(issue => issue.path.startsWith('merges')))
    maps.merges.clear()
  }
})

documentTest('password records and Unicode strings retain the portable version-one contract', (doc, maps) => {
  const password = { version: 1, algorithm: 'PBKDF2-SHA-256', iterations: 600000, salt: 'a'.repeat(32), verifier: 'b'.repeat(64) }
  maps.locks.set('0:0', JSON.stringify(password))
  maps.cells.set('0:0', 'valid 😀')
  assert.deepEqual(validateSheetDocument(doc), [])
  assert.deepEqual(readSheetSnapshot(doc).locks['0:0'], password)
  maps.locks.set('0:0', JSON.stringify({ ...password, verifier: 'invalid' }))
  assert.ok(validateSheetDocument(doc).some(issue => issue.path === 'locks.0:0'))
  maps.locks.clear()
  maps.cells.set('0:0', '\ud800')
  assert.ok(validateSheetDocument(doc).some(issue => issue.path === 'cells.0:0'))
  maps.cells.clear()
  maps.styles.set('0:0', '{"color":"\\udfff"}')
  assert.ok(validateSheetDocument(doc).some(issue => issue.path === 'styles.0:0'))
})


test('incomplete causal updates cannot conceal pending content or delete dependencies', () => {
  const source = new Y.Doc()
  const pending = new Y.Doc()
  const deletion = new Y.Doc()
  try {
    source.getText('cells').insert(0, 'first')
    const vector = Y.encodeStateVector(source)
    source.getText('cells').insertEmbed(5, { unsafe: true })
    Y.applyUpdate(pending, Y.encodeStateAsUpdate(source, vector))
    assert.notEqual(pending.store.pendingStructs, null)
    assert.ok(validateSheetDocument(pending).some(issue => issue.message.includes('unresolved')))
    assert.throws(() => readSheetSnapshot(pending), /unresolved/)
    const initial = Y.encodeStateVector(source)
    source.getText('cells').delete(0, 1)
    Y.applyUpdate(deletion, Y.encodeStateAsUpdate(source, initial))
    assert.notEqual(deletion.store.pendingDs, null)
    assert.ok(validateSheetDocument(deletion).some(issue => issue.message.includes('unresolved')))
  } finally { source.destroy(); pending.destroy(); deletion.destroy() }
})

documentTest('merge limits remain explicit host policy and never change the default document format', (doc, maps) => {
  maps.merges.set('0:0-9999:999', '1')
  assert.deepEqual(validateSheetDocument(doc), [])
  assert.ok(validateSheetDocument(doc, { maxMergeArea: 10000 }).some(issue => issue.message.includes('maxMergeArea')))
  maps.merges.clear()
  maps.merges.set('0:0-99:99', '1')
  assert.deepEqual(validateSheetDocument(doc, { maxMergeArea: 10000, maxMerges: 1 }), [])
  maps.merges.set('100:0-100:1', '1')
  assert.ok(validateSheetDocument(doc, { maxMerges: 1 }).some(issue => issue.message.includes('maxMerges')))
})
