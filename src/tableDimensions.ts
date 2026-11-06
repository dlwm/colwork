import type { Awareness } from 'y-protocols/awareness'
import type { SheetDocument } from './sheetDocument'
import type { TableSelection } from './tableSelection'
import { selectionFocusForMode, type AwarenessSelection } from './selection'
import type { ColworkTableOptions } from './options'

/** Logical local capacity grows to include document data and collaborators' selections. */
export class TableDimensions {
  rows: number
  columns: number
  constructor(options: ColworkTableOptions) {
    for (const value of [options.rowCount, options.columnCount]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError('Table dimensions must be positive safe integers')
    }
    const external = options.transport === 'external'
    this.rows = Math.max(options.rowCount ?? 100, external ? 1 : options.rows?.length ?? 10)
    this.columns = Math.max(options.columnCount ?? 10, external ? 1 : 6)
  }
  expandDocument(sheet: SheetDocument) {
    const size = sheet.getContentSize()
    const changed = size.rows > this.rows || size.columns > this.columns
    this.rows = Math.max(this.rows, size.rows)
    this.columns = Math.max(this.columns, size.columns)
    return changed
  }
  expandRemote(awareness: Awareness) {
    const rows = this.rows
    const columns = this.columns
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.clientID) return
      const selection = state.selection as AwarenessSelection | undefined
      if (!selection?.anchor || !selection.focus) return
      this.rows = Math.max(this.rows, selection.anchor.row + 1, selection.focus.row + 1)
      this.columns = Math.max(this.columns, selection.anchor.column + 1, selection.focus.column + 1)
    })
    return rows !== this.rows || columns !== this.columns
  }
  expandViewport(viewport: HTMLElement, selection: TableSelection) {
    const nearBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 280
    const nearRight = viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 280
    if (nearBottom) this.rows += 100
    if (nearRight) this.columns += 5
    if (selection.mode && (nearBottom || nearRight)) {
      selection.focus = selectionFocusForMode(selection.mode, selection.focus ?? { row: 0, column: 0 }, this.rows, this.columns)
      selection.publishSelection()
    }
  }
}
