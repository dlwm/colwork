import * as Y from 'yjs'
import type { WorkbookValidationLimits } from './model-schema'
import { colworkRoot, validateWorkbook } from './model-validation'
import { MAIN_SHEET_ID, sheetIdPattern, workbookRoot } from './workbookModel'

/** Replaces Colwork state in place. The host owns revision checks and stale-session fencing. */
export function restoreWorkbookVersion(document: Y.Doc, update: Uint8Array, options: {
  origin?: unknown
  limits?: WorkbookValidationLimits
} = {}) {
  const saved = new Y.Doc()
  try {
    Y.applyUpdate(saved, update)
    const [issue] = validateWorkbook(saved, { ...options.limits, allowUnknownRoots: true })
    if (issue) throw new TypeError(`Invalid Colwork version at ${issue.path}: ${issue.message}`)
    const names = new Set([...document.share.keys(), ...saved.share.keys()])
    const savedSheets = saved.getMap<string | null>(workbookRoot)
    const deletedSheets = new Set<string>()
    for (const id of document.getMap(workbookRoot).keys()) {
      if (id !== MAIN_SHEET_ID && sheetIdPattern.test(id) && !savedSheets.has(id)) deletedSheets.add(id)
    }
    // Yjs retains roots with deleted content even when encoding a fresh full update.
    for (const name of names) {
      const id = colworkRoot(name)?.sheetId
      if (id && id !== MAIN_SHEET_ID && !savedSheets.has(id)) deletedSheets.add(id)
    }
    // Materialize and inspect every root before starting the restoring transaction.
    const changes = [...names].flatMap(name => {
      switch (colworkRoot(name)?.type) {
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
            for (const key of live.keys()) {
              if (name === workbookRoot && deletedSheets.has(key)) continue
              if (!next.has(key)) live.delete(key)
            }
            for (const [key, value] of next) {
              const current = live.get(key)
              if (Array.isArray(value)) {
                if (!Array.isArray(current) || value.length !== current.length || value.some((id, index) => id !== current[index])) live.set(key, [...value])
              } else if (current !== value) live.set(key, value)
            }
            if (name === workbookRoot) {
              for (const id of deletedSheets) if (live.get(id) !== null) live.set(id, null)
            }
          }]
        }
        default: return []
      }
    })
    document.transact(() => { changes.forEach(change => change()) }, options.origin)
  } finally { saved.destroy() }
}
