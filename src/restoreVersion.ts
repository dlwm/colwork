import * as Y from 'yjs'
import { COLWORK_MAP_NAMES, type SheetValidationLimits } from './model-schema'
import { validateSheetDocument } from './model-validation'
import { axisRootNames } from './sheetCoordinates'
import { featureRootNames } from './sheetFeatures'
import { MAIN_SHEET_ID, normalizeSheetName, sheetIdPattern, workbookOrderRoot, workbookRoot } from './workbookModel'

const sequences = new Set<string>([workbookOrderRoot, ...Object.values(axisRootNames)])
const maps = new Set<string>([workbookRoot, ...Object.values(COLWORK_MAP_NAMES), ...Object.values(featureRootNames)])

function rootType(key: string): 'array' | 'map' | undefined {
  const [prefix, id, name, extra] = key.split(':')
  if (id !== undefined) {
    if (prefix !== 'colwork-sheet' || id === MAIN_SHEET_ID || !sheetIdPattern.test(id) || !name || extra !== undefined
      || name === workbookRoot || name === workbookOrderRoot) return
    key = name
  }
  if (sequences.has(key)) return 'array'
  if (maps.has(key)) return 'map'
}

/** Replaces visible Colwork state inside the existing collaborative document. */
export function restoreWorkbookVersion(document: Y.Doc, update: Uint8Array, options: {
  origin?: unknown
  limits?: SheetValidationLimits
} = {}) {
  const saved = new Y.Doc()
  try {
    Y.applyUpdate(saved, update)
    const ids = new Set([MAIN_SHEET_ID])
    for (const name of saved.share.keys()) {
      if (rootType(name) && name.startsWith('colwork-sheet:')) ids.add(name.split(':')[1])
    }
    const sheets = saved.getMap<string | null>(workbookRoot)
    const order = saved.getArray<string>(workbookOrderRoot)
    if (sheets._start !== null || order._map.size || order.toArray().some(id => typeof id !== 'string' || !sheetIdPattern.test(id))) {
      throw new TypeError('Invalid workbook history')
    }
    for (const [id, name] of sheets) {
      if (!sheetIdPattern.test(id) || (name !== null && typeof name !== 'string')) throw new TypeError('Invalid workbook sheet')
      if (name !== null) normalizeSheetName(name)
      ids.add(id)
    }
    for (const id of ids) {
      const [issue] = validateSheetDocument(saved, { ...options.limits, allowUnknownRoots: true }, id)
      if (issue) throw new TypeError(`Invalid Colwork version at ${issue.path}: ${issue.message}`)
    }
    const names = new Set([...document.share.keys(), ...saved.share.keys()])
    // Materialize and inspect every root before starting the restoring transaction.
    const changes = [...names].flatMap(name => {
      switch (rootType(name)) {
        case 'array': {
          const live = document.getArray<unknown>(name)
          const previous = live.toArray()
          const next = saved.getArray<unknown>(name).toArray()
          if (previous.length === next.length && previous.every((value, index) => value === next[index])) return []
          return [() => { live.delete(0, live.length); live.push(next) }]
        }
        case 'map': {
          const live = document.getMap<unknown>(name), next = saved.getMap<unknown>(name)
          return [() => {
            for (const key of live.keys()) if (!next.has(key)) live.delete(key)
            for (const [key, value] of next) if (live.get(key) !== value) live.set(key, value)
          }]
        }
        default: return []
      }
    })
    document.transact(() => { changes.forEach(change => change()) }, options.origin)
  } finally { saved.destroy() }
}
