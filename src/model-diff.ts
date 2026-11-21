import type { WorkbookSnapshot } from './model'
import { mergeKey } from './model-schema'

export type WorkbookCellChange = { key: string; before?: string; after?: string }
export type WorkbookRuleChange = { kind: 'validation' | 'conditional' | 'analyses'; key: string; change: 'added' | 'removed' | 'modified' }
export type WorkbookSheetChange = {
  id: string
  name: string
  previousName?: string
  change: 'added' | 'removed' | 'modified'
  moved: boolean
  cells: { count: number; examples: WorkbookCellChange[] }
  rules: { count: number; examples: WorkbookRuleChange[]; precedenceChanged: boolean }
  properties: Array<'dimensions' | 'styles' | 'rowHeights' | 'columnWidths' | 'merges' | 'locks'>
}

function changedEntries<T>(
  before: Record<string, T>,
  after: Record<string, T>,
  visit: (key: string, oldValue: T | undefined, newValue: T | undefined) => void,
) {
  const get = (map: Record<string, T>, key: string) => Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
  for (const key of Object.keys(before)) {
    const next = get(after, key)
    if (before[key] !== next) visit(key, before[key], next)
  }
  for (const key of Object.keys(after)) if (get(before, key) === undefined) visit(key, undefined, after[key])
}

type WorkbookSheet = WorkbookSnapshot['sheets'][number]

function changedRules(before: WorkbookSheet['features'] | undefined, after: WorkbookSheet['features'] | undefined,
  capacity: number): WorkbookSheetChange['rules'] {
  const result: WorkbookSheetChange['rules'] = { count: 0, examples: [], precedenceChanged: false }
  const compare = (kind: WorkbookRuleChange['kind'], previous: Array<[string, string]>, current: Array<[string, string]>) => {
    if (kind !== 'analyses') {
      const earlier = new Set(previous.map(([key]) => key))
      const later = new Set(current.map(([key]) => key))
      const order = previous.filter(([key]) => later.has(key)).map(([key]) => key)
      const nextOrder = current.filter(([key]) => earlier.has(key)).map(([key]) => key)
      result.precedenceChanged ||= order.some((key, index) => key !== nextOrder[index])
    }
    changedEntries(Object.fromEntries(previous), Object.fromEntries(current), (key, oldValue, newValue) => {
      result.count++
      if (result.examples.length < capacity) {
        result.examples.push({ kind, key, change: oldValue === undefined ? 'added' : newValue === undefined ? 'removed' : 'modified' })
      }
    })
  }
  const entries = (rules: WorkbookSheet['features']['validation'] | WorkbookSheet['features']['conditional'] | undefined): Array<[string, string]> =>
    (rules ?? []).map(({ range, rule }) => [mergeKey(range), JSON.stringify(rule)])
  const analyses = (rules: WorkbookSheet['features']['analyses'] | undefined): Array<[string, string]> =>
    (rules ?? []).map(rule => [rule.id, JSON.stringify(rule)])
  compare('validation', entries(before?.validation), entries(after?.validation))
  compare('conditional', entries(before?.conditional), entries(after?.conditional))
  compare('analyses', analyses(before?.analyses), analyses(after?.analyses))
  return result
}

/** Counts all changes and caps the number of cell and rule examples across the workbook. */
export function compareWorkbookSnapshots(before: WorkbookSnapshot, after: WorkbookSnapshot, options: { maxExamples?: number } = {}): WorkbookSheetChange[] {
  const limit = options.maxExamples ?? 100
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('maxExamples must be a non-negative safe integer')
  const previous = new Map(before.sheets.map(sheet => [sheet.id, sheet]))
  const current = new Map(after.sheets.map(sheet => [sheet.id, sheet]))
  const oldOrder = new Map(before.sheets.filter(({ id }) => current.has(id)).map(({ id }, index) => [id, index]))
  const newOrder = new Map(after.sheets.filter(({ id }) => previous.has(id)).map(({ id }, index) => [id, index]))
  const properties = ['styles', 'rowHeights', 'columnWidths', 'merges', 'locks'] as const
  const result: WorkbookSheetChange[] = []
  let remaining = limit
  for (const id of new Set([...current.keys(), ...previous.keys()])) {
    const a = previous.get(id), b = current.get(id)
    const oldSheet = a?.snapshot, newSheet = b?.snapshot
    const change: WorkbookSheetChange = {
      id, name: (b ?? a)!.name,
      ...(a && b && a.name !== b.name ? { previousName: a.name } : {}),
      change: !a ? 'added' : !b ? 'removed' : 'modified',
      moved: oldOrder.get(id) !== newOrder.get(id),
      cells: { count: 0, examples: [] },
      rules: { count: 0, examples: [], precedenceChanged: false },
      properties: [],
    }
    changedEntries(oldSheet?.cells ?? {}, newSheet?.cells ?? {}, (key, before, after) => {
      change.cells.count++
      if (remaining > 0) { change.cells.examples.push({ key, before, after }); remaining-- }
    })
    change.rules = changedRules(a?.features, b?.features, remaining)
    remaining -= change.rules.examples.length
    if (a && b) {
      if (oldSheet!.rowCount !== newSheet!.rowCount || oldSheet!.columnCount !== newSheet!.columnCount) change.properties.push('dimensions')
      for (const property of properties) {
        if (JSON.stringify(oldSheet![property]) !== JSON.stringify(newSheet![property])) change.properties.push(property)
      }
    }
    if (!a || !b || change.previousName !== undefined || change.moved || change.cells.count || change.rules.count
      || change.rules.precedenceChanged || change.properties.length) result.push(change)
  }
  return result
}
