import type * as Y from 'yjs'
import { containsPosition, type CellRange } from './range'
import { parseCellKey } from './model-schema'
import { parseAxisId, SheetCoordinates } from './sheetCoordinates'
import { sheetRoot } from './workbookModel'

export const featureRootNames = {
  validation: 'colwork-validation',
  conditional: 'colwork-conditional-format',
  analyses: 'colwork-analyses',
} as const

export type ColworkDataValidation = { choices: string[] }
export type ColworkConditionalFormat = {
  operator: 'contains' | 'equals' | 'greater' | 'less' | 'empty'
  value: string
  background: string
}
export type ColworkAnalysis = {
  name: string
  range: string
  kind: 'bar' | 'line' | 'pivot'
  group: string
  value: string
  column?: string
  summarize: 'sum' | 'count' | 'average'
}

export function getSheetFeatureMaps(document: Y.Doc, sheetId?: string) {
  return {
    validation: document.getMap<string>(sheetRoot(featureRootNames.validation, sheetId)),
    conditional: document.getMap<string>(sheetRoot(featureRootNames.conditional, sheetId)),
    analyses: document.getMap<string>(sheetRoot(featureRootNames.analyses, sheetId)),
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isDataValidation(value: unknown): value is ColworkDataValidation {
  return object(value) && Array.isArray(value.choices) && value.choices.length > 0 && value.choices.length <= 100
    && value.choices.every(choice => typeof choice === 'string' && choice.trim() && choice.length <= 255)
    && value.choices.length === new Set(value.choices).size
}

export function isConditionalFormat(value: unknown): value is ColworkConditionalFormat {
  return object(value) && ['contains', 'equals', 'greater', 'less', 'empty'].includes(String(value.operator))
    && typeof value.value === 'string' && value.value.length <= 255
    && (value.operator !== 'greater' && value.operator !== 'less' || !!value.value.trim() && Number.isFinite(Number(value.value)))
    && typeof value.background === 'string' && /^#[0-9a-f]{6}$/i.test(value.background)
}

export function isAnalysis(value: unknown): value is ColworkAnalysis {
  const columnId = (id: unknown) => typeof id === 'string' && !!parseAxisId(id)
  return object(value) && typeof value.name === 'string' && !!value.name.trim() && value.name.length <= 80
    && typeof value.range === 'string' && ['bar', 'line', 'pivot'].includes(String(value.kind))
    && columnId(value.group) && columnId(value.value) && (value.column === undefined || columnId(value.column))
    && ['sum', 'count', 'average'].includes(String(value.summarize))
}

export function readFeature<T>(value: unknown, check: (value: unknown) => value is T): T | undefined {
  if (typeof value !== 'string' || value.length > 32000) return undefined
  try {
    const result: unknown = JSON.parse(value)
    return check(result) ? result : undefined
  } catch { return undefined }
}

export function matchesConditionalFormat(rule: ColworkConditionalFormat, value: string) {
  switch (rule.operator) {
    case 'contains': return value.toLowerCase().includes(rule.value.toLowerCase())
    case 'equals': return value.toLowerCase() === rule.value.toLowerCase()
    case 'greater': return !!value.trim() && Number(value) > Number(rule.value)
    case 'less': return !!value.trim() && Number(value) < Number(rule.value)
    case 'empty': return value === ''
  }
}

export class SheetFeatures {
  readonly maps
  private rules?: {
    validation: Array<{ range: CellRange; rule: ColworkDataValidation }>
    conditional: Array<{ range: CellRange; rule: ColworkConditionalFormat }>
  }
  constructor(private readonly document: Y.Doc, private readonly sheetId: string, private readonly coordinates: SheetCoordinates) {
    this.maps = getSheetFeatureMaps(document, sheetId)
  }

  invalidate() { this.rules = undefined }

  private get projected() {
    if (this.rules) return this.rules
    const canonical = new SheetCoordinates(this.document, this.sheetId)
    const project = <T>(map: Y.Map<string>, check: (value: unknown) => value is T) =>
      [...map].sort(([left], [right]) => right.localeCompare(left)).flatMap(([key, raw]) => {
        const range = canonical.mergeRange(key)
        const rule = readFeature(raw, check)
        return rule && range ? [{ range, rule }] : []
      })
    return this.rules = {
      validation: project(this.maps.validation, isDataValidation),
      conditional: project(this.maps.conditional, isConditionalFormat),
    }
  }

  validationAt(key: string) {
    const position = this.canonicalPosition(key)
    return position && this.projected.validation.find(({ range }) => containsPosition(range, position))?.rule
  }

  accepts(key: string, value: string) {
    const validation = this.validationAt(key)
    return !validation || !value || validation.choices.includes(value)
  }

  backgroundAt(key: string, value: string) {
    const position = this.canonicalPosition(key)
    return position && this.projected.conditional.find(({ range, rule }) =>
      containsPosition(range, position) && matchesConditionalFormat(rule, value))?.rule.background
  }

  extent() {
    let rows = 1, columns = 1
    for (const { range } of [...this.projected.validation, ...this.projected.conditional]) {
      const first = this.coordinates.visualRow(range.start.row)
      const last = this.coordinates.visualRow(range.end.row)
      rows = Math.max(rows, (first ?? -1) + 1, (last ?? -1) + 1)
      columns = Math.max(columns, range.end.column + 1)
    }
    return { rows, columns }
  }

  rangeFor(range: CellRange) { return this.coordinates.mergeId(`${range.start.row}:${range.start.column}-${range.end.row}:${range.end.column}`) }

  private canonicalPosition(key: string) {
    const cell = parseCellKey(key)
    if (!cell) return
    const row = this.coordinates.canonicalRow(cell.row)
    if (row !== undefined) return { row, column: cell.column }
  }
}
