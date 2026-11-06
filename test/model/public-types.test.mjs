import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const modelConsumer = `
import * as Y from 'yjs'
import { COLWORK_SCHEMA_VERSION, COLWORK_MAP_NAMES, getSheetMaps, readSheetSnapshot, type SheetSnapshot, type SheetValidationLimits } from '@kuzuma/colwork/model'
const doc = new Y.Doc()
const limits: SheetValidationLimits = { maxMergeArea: 10000, maxMerges: 1000 }
const snapshot: SheetSnapshot = readSheetSnapshot(doc, limits)
const version: 1 = COLWORK_SCHEMA_VERSION
const root: 'cells' = COLWORK_MAP_NAMES.cells
getSheetMaps(doc).cells.set('0:0', 'typed')
// @ts-expect-error Exported cell types must remain strings, rather than unresolved any.
const invalid: number = snapshot.cells['0:0']
`
const commonJSConsumer = `
import model = require('@kuzuma/colwork/model')
import type { SheetSnapshot, SheetValidationLimits } from '@kuzuma/colwork/model'
import Y = require('yjs')
const doc = new Y.Doc()
const limits: SheetValidationLimits = { maxMergeArea: 10000, maxMerges: 1000 }
const snapshot: SheetSnapshot = model.readSheetSnapshot(doc, limits)
const version: 1 = model.COLWORK_SCHEMA_VERSION
// @ts-expect-error The CJS declaration must preserve typed cell exports.
const invalid: number = snapshot.cells['0:0']
`
const browserConsumer = `
import { ColworkTable, type ColworkTableOptions, type EditingState } from '@kuzuma/colwork'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
const document = new Y.Doc()
const awareness = new Awareness(document)
const options: ColworkTableOptions = { transport: 'external', collaboration: { document, awareness }, user: 'test', onEditingChange(state: EditingState) { state.dirty } }
const table = new ColworkTable(globalThis.document.createElement('div'), options)
table.commitEditing()
table.cancelEditing()
table.setReadOnly(true)
// @ts-expect-error Built-in transport continues to require a room.
const missingRoom: ColworkTableOptions = { transport: 'websocket', user: 'test' }
// @ts-expect-error External documents cannot use widget-owned snapshot initialization.
const badSnapshot: ColworkTableOptions = { ...options, snapshot: new Uint8Array() }
`

function checkConsumer(name, extension, source, browser = false) {
  test(name, () => {
    const filePath = fileURLToPath(new URL(`./consumer.${extension}`, import.meta.url))
    const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
      module: browser ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
      moduleResolution: browser ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
      lib: browser ? ['lib.es2022.d.ts', 'lib.dom.d.ts'] : ['lib.es2022.d.ts'] }
    const host = ts.createCompilerHost(options)
    const original = host.getSourceFile
    host.getSourceFile = (path, languageVersion, onError, fresh) => path === filePath
      ? ts.createSourceFile(path, source, languageVersion, true)
      : original(path, languageVersion, onError, fresh)
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filePath], options, host))
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    }))
  })
}
checkConsumer('model declarations support NodeNext ESM without the DOM library', 'mts', modelConsumer)
checkConsumer('model declarations support NodeNext require and type imports without the DOM library', 'cts', commonJSConsumer)
checkConsumer('browser declarations preserve discriminated options and explicit editing APIs under Bundler', 'ts', browserConsumer, true)
