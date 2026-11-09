import type * as Y from 'yjs'
import { cellKey, type CellRange } from './range'
import { parseCellKey, parseMergeKey, type SheetMaps } from './model-schema'
import { sheetRoot } from './workbookModel'

export const axisRootNames = { row: 'colwork-row-edits', column: 'colwork-column-edits' } as const
export type SheetAxis = keyof typeof axisRootNames

export function parseAxisId(id: string) {
  const match = /^(0|[1-9]\d*)(~[0-9a-f]{32})?$/.exec(id)
  const base = Number(match?.[1])
  if (!Number.isSafeInteger(base) || base >= Number.MAX_SAFE_INTEGER) return undefined
  return { base, inserted: Boolean(match?.[2]) }
}

type Block = { base: number; start: number; delta: number; inserted: string[]; deleted: boolean }

// Unchanged rows and columns keep their original numeric IDs. Only structural edits are stored.
class AxisProjection {
  private readonly blocks: Block[] = []
  private readonly insertedPositions = new Map<string, number>()
  readonly extent: number
  readonly delta: number

  constructor(operations: string[]) {
    const deleted = new Set(operations.filter(operation => typeof operation === 'string' && operation.startsWith('!')).map(operation => operation.slice(1)))
    const byBase = new Map<number, string[]>()
    for (const operation of operations) {
      if (typeof operation !== 'string') continue
      const isDeletion = operation.startsWith('!')
      const id = isDeletion ? operation.slice(1) : operation
      const parsed = parseAxisId(id)
      if (!parsed) continue
      const { base, inserted } = parsed
      if (!byBase.has(base)) byBase.set(base, [])
      if (!isDeletion && inserted && !deleted.has(id)) byBase.get(base)!.push(id)
    }
    let delta = 0
    let extent = 1
    for (const [base, inserted] of [...byBase].sort(([a], [b]) => a - b)) {
      const start = base + delta
      const removed = deleted.has(String(base))
      inserted.forEach((id, index) => this.insertedPositions.set(id, start + index))
      if (inserted.length) extent = Math.max(extent, start + inserted.length)
      delta += inserted.length - Number(removed)
      this.blocks.push({ base, start, delta, inserted, deleted: removed })
    }
    this.extent = extent
    this.delta = delta
  }

  private lastBlock(value: number, key: 'start' | 'base') {
    let low = 0
    let high = this.blocks.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.blocks[middle][key] <= value) low = middle + 1
      else high = middle
    }
    return this.blocks[low - 1]
  }

  idAt(index: number): string {
    const block = this.lastBlock(index, 'start')
    return block?.inserted[index - block.start] ?? String(index - (block?.delta ?? 0))
  }

  positionOf(id: string): number | undefined {
    // Inserted IDs have a suffix, while base IDs remain positional before the first operation.
    if (id.includes('~')) return this.insertedPositions.get(id)
    const parsed = parseAxisId(id)
    if (!parsed) return undefined
    const block = this.lastBlock(parsed.base, 'base')
    if (block?.base === parsed.base && block.deleted) return undefined
    return parsed.base + (block?.delta ?? 0)
  }
}

export class SheetCoordinates {
  readonly edits
  private cache?: Record<SheetAxis, AxisProjection>
  private view?: { rows: number[]; positions: Map<number, number>; extent: number; filtered: boolean }

  constructor(doc: Y.Doc, sheetId?: string) {
    this.edits = { row: doc.getArray<string>(sheetRoot(axisRootNames.row, sheetId)), column: doc.getArray<string>(sheetRoot(axisRootNames.column, sheetId)) }
  }

  invalidate() { this.cache = undefined }

  get axes() {
    return this.cache ??= { row: new AxisProjection(this.edits.row.toArray()), column: new AxisProjection(this.edits.column.toArray()) }
  }

  extent(axis: SheetAxis) { return this.axes[axis].extent }
  setRowOrder(rows: number[] | undefined, extent = 0, filtered = false) {
    this.view = rows && { rows, positions: new Map(rows.map((row, index) => [row, index])), extent, filtered }
  }
  get hasRowOrder() { return !!this.view }
  visibleRowCount(capacity: number) {
    if (!this.view) return capacity
    return this.view.filtered ? Math.max(1, this.view.rows.length) : capacity
  }
  canonicalRow(index: number) {
    const view = this.view
    if (!view) return index
    return view.rows[index] ?? (view.filtered ? undefined : index - view.rows.length + view.extent)
  }
  visualRow(index: number) {
    const view = this.view
    if (!view) return index
    return view.positions.get(index) ?? (!view.filtered && index >= view.extent ? index - view.extent + view.rows.length : undefined)
  }
  axisId(axis: SheetAxis, index: number) {
    const canonical = axis === 'row' ? this.canonicalRow(index) : index
    return canonical === undefined ? undefined : this.axes[axis].idAt(canonical)
  }
  axisPosition(axis: SheetAxis, id: string) {
    const canonical = this.axes[axis].positionOf(id)
    return axis === 'row' && canonical !== undefined ? this.visualRow(canonical) : canonical
  }

  cellId(key: string) {
    const position = parseCellKey(key)
    if (!position) return undefined
    const row = this.axisId('row', position.row)
    const column = this.axisId('column', position.column)
    return row === undefined || column === undefined ? undefined : `${row}:${column}`
  }

  cellPosition(id: string) {
    const [rowId, columnId, extra] = id.split(':')
    if (!rowId || !columnId || extra !== undefined) return undefined
    const row = this.axisPosition('row', rowId)
    const column = this.axisPosition('column', columnId)
    return row === undefined || column === undefined ? undefined : { row, column }
  }

  cellKey(id: string) {
    const position = this.cellPosition(id)
    return position ? cellKey(position) : undefined
  }

  mergeId(key: string) {
    const range = parseMergeKey(key)
    if (!range) return undefined
    const start = this.cellId(cellKey(range.start))
    const end = this.cellId(cellKey(range.end))
    return start && end ? `${start}-${end}` : undefined
  }

  mergeRange(id: string): CellRange | undefined {
    const [startId, endId, extra] = id.split('-')
    if (!startId || !endId || extra !== undefined) return undefined
    const start = this.cellPosition(startId)
    const end = this.cellPosition(endId)
    if (!start || !end || start.row > end.row || start.column > end.column) return undefined
    return { start, end }
  }

  mergeKey(id: string) {
    const range = this.mergeRange(id)
    return range ? `${cellKey(range.start)}-${cellKey(range.end)}` : undefined
  }

  project(maps: SheetMaps) {
    const cellMap = <T>(map: Y.Map<T>) => new ProjectedMap(map, key => this.cellId(key), id => this.cellKey(id))
    const sizeMap = (map: Y.Map<number>, axis: SheetAxis) => new ProjectedMap(map,
      key => this.axisId(axis, Number(key)), id => this.axisPosition(axis, id)?.toString())
    return {
      cells: cellMap(maps.cells), styles: cellMap(maps.styles), locks: cellMap(maps.locks),
      rowHeights: sizeMap(maps.rowHeights, 'row'), columnWidths: sizeMap(maps.columnWidths, 'column'),
      merges: new ProjectedMap(maps.merges, key => this.mergeId(key), id => this.mergeKey(id)),
    }
  }

  insert(axis: SheetAxis, index: number, count: number) {
    const before = this.axes[axis].idAt(index)
    const anchor = parseAxisId(before)!
    const operations = this.edits[axis]
    const entries = operations.toArray()
    // The original row is the end of its group. Y.Array orders simultaneous insertions within each group.
    let offset = anchor.inserted ? entries.indexOf(before) : operations.length
    if (!anchor.inserted) {
      const prefix = `${anchor.base}~`
      for (let last = entries.length - 1; last >= 0; last--) {
        if (typeof entries[last] === 'string' && entries[last].startsWith(prefix)) {
          offset = last + 1
          break
        }
      }
    }
    operations.insert(offset, Array.from({ length: count }, () => {
      const random = crypto.getRandomValues(new Uint8Array(16))
      const suffix = Array.from(random, value => value.toString(16).padStart(2, '0')).join('')
      return `${anchor.base}~${suffix}`
    }))
    this.invalidate()
  }

  remove(axis: SheetAxis, index: number, count: number) {
    const projection = this.axes[axis]
    this.edits[axis].push(Array.from({ length: count }, (_, offset) => `!${projection.idAt(index + offset)}`))
    this.invalidate()
  }
}

/** Maps visual coordinates to stable keys at the view boundary. */
export class ProjectedMap<T> {
  constructor(readonly raw: Y.Map<T>, private readonly toId: (key: string) => string | undefined, private readonly toKey: (id: string) => string | undefined) {}
  get size() { return this.raw.size }
  get(key: string) { const id = this.toId(key); return id === undefined ? undefined : this.raw.get(id) }
  has(key: string) { const id = this.toId(key); return id !== undefined && this.raw.has(id) }
  set(key: string, value: T) { const id = this.toId(key); if (id !== undefined) this.raw.set(id, value) }
  delete(key: string) { const id = this.toId(key); if (id !== undefined) this.raw.delete(id) }
  clear() { this.raw.clear() }
  *entries(): IterableIterator<[string, T]> {
    for (const [id, value] of this.raw) {
      const key = this.toKey(id)
      if (key !== undefined) yield [key, value]
    }
  }
  *keys() { for (const [key] of this.entries()) yield key }
  [Symbol.iterator]() { return this.entries() }
}
