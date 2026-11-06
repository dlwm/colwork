import { cellKey, type CellPosition } from './range'
import { selectionRange } from './selection'
import type { TableSelection } from './tableSelection'
import type { ContextMenu } from './context-menu'
import type { CellEditor } from './cellEditor'
import type { TableDialogs } from './dialogs'
import type { TableClipboard } from './clipboard'
type PointerHost = {
  selection: TableSelection
  menu: ContextMenu
  viewport: HTMLElement
  editing: CellEditor
  dialogs: TableDialogs
  clipboard: TableClipboard
  canEdit(): boolean
  freezeSelection(axis: 'row' | 'column'): void
  setFrozenPanes(rows: number, columns: number): unknown
  modifyAxis(axis: 'row' | 'column', index: number, amount: number): void
  deleteRows(): void
  deleteColumns(): void
  mergeSelection(): void
  unmergeSelection(): void
  clearSelectionContents(): void
  refreshSelection(): void
}

export class PointerInteraction {
  selecting = false
  headerSelecting?: { axis: 'row' | 'column'; anchor: number }
  private pendingCellContext?: { x: number; y: number }
  private rightButtonReleased = false
  private rightMouseUpPoint?: { x: number; y: number }
  private rightDrag?: { start: CellPosition; moved: boolean }
  constructor(private readonly host: PointerHost) {}
  cancel() {
    this.selecting = false
    this.headerSelecting = undefined
    this.pendingCellContext = undefined
    this.rightDrag = undefined
  }
  release(event: MouseEvent) {
    this.selecting = false
    this.headerSelecting = undefined
    if (event.button === 2) {
      this.rightButtonReleased = true
      this.rightMouseUpPoint = { x: event.clientX, y: event.clientY }
      if (this.pendingCellContext) {
        this.pendingCellContext = undefined
        this.showCellContextMenu(event.clientX, event.clientY)
      }
    }
    if (this.host.selection.pendingCursor) this.host.selection.sendAwareness(this.host.selection.pendingCursor)
  }
  blur() {
    if (!this.headerSelecting) return
    this.selecting = false
    this.headerSelecting = undefined
    if (this.host.selection.pendingCursor) this.host.selection.sendAwareness(this.host.selection.pendingCursor)
  }

  protectionActions(): Array<[string, () => void]> {
    return [
      ['锁定选区', () => this.host.dialogs.requestSelectionLock(true)],
      ['密码锁定选区', () => this.host.dialogs.requestSelectionLock(true, true)],
      ['解锁选区', () => this.host.dialogs.requestSelectionLock(false)],
    ]
  }

  hasHeaderSelection(axis: 'row' | 'column', index: number) {
    const range = selectionRange(this.host.selection.anchor, this.host.selection.focus)
    return this.host.selection.mode === axis && (axis === 'row'
      ? index >= range.start.row && index <= range.end.row
      : index >= range.start.column && index <= range.end.column)
  }

  openRowContextMenu(event: MouseEvent, row: number) {
    if (!this.host.canEdit()) return
    event.preventDefault()
    event.stopPropagation()
    if (!this.hasHeaderSelection('row', row)) this.host.selection.selectHeaderRange('row', row, false)
    const range = selectionRange(this.host.selection.anchor, this.host.selection.focus)
    const count = range.end.row - range.start.row + 1
    this.host.menu.show(event.clientX, event.clientY, [
      { label: '行操作', actions: [
        [`在上方插入 ${count} 行`, () => this.host.modifyAxis('row', range.start.row, count)],
        [`在下方插入 ${count} 行`, () => this.host.modifyAxis('row', range.end.row + 1, count)],
        [`删除 ${count} 行`, () => this.host.deleteRows()],
      ] },
      { label: '固定', actions: [
        ['固定至此行', () => this.host.freezeSelection('row')],
        ['取消固定', () => this.host.setFrozenPanes(0, 0)],
      ] },
      { label: '保护', actions: this.protectionActions() },
    ])
  }

  openColumnContextMenu(event: MouseEvent, column: number) {
    if (!this.host.canEdit()) return
    event.preventDefault()
    event.stopPropagation()
    if (!this.hasHeaderSelection('column', column)) this.host.selection.selectHeaderRange('column', column, false)
    const range = selectionRange(this.host.selection.anchor, this.host.selection.focus)
    const count = range.end.column - range.start.column + 1
    this.host.menu.show(event.clientX, event.clientY, [
      { label: '列操作', actions: [
        [`在左侧插入 ${count} 列`, () => this.host.modifyAxis('column', range.start.column, count)],
        [`在右侧插入 ${count} 列`, () => this.host.modifyAxis('column', range.end.column + 1, count)],
        [`删除 ${count} 列`, () => this.host.deleteColumns()],
      ] },
      { label: '固定', actions: [
        ['固定至此列', () => this.host.freezeSelection('column')],
        ['取消固定', () => this.host.setFrozenPanes(0, 0)],
      ] },
      { label: '保护', actions: this.protectionActions() },
    ])
  }

  addHeaderSelection(element: HTMLElement, axis: 'row' | 'column', index: number) {
    element.dataset.selectionAxis = axis
    element.dataset.selectionIndex = String(index)
    element.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      this.host.editing.finish(true)
      this.host.viewport.focus({ preventScroll: true })
      this.host.menu.hide()
      this.host.selection.selectHeaderRange(axis, index, event.shiftKey)
      this.headerSelecting = { axis, anchor: this.host.selection.anchor![axis] }
      this.selecting = true
    })
    element.addEventListener('mouseenter', (event) => {
      if (!this.selecting || !this.headerSelecting || this.headerSelecting.axis !== axis) return
      if (!(event.buttons & 1)) { this.blur(); return }
      this.host.selection.selectHeaderSpan(axis, this.headerSelecting.anchor, index)
    })
    element.addEventListener('contextmenu', (event) => axis === 'row' ? this.openRowContextMenu(event, index) : this.openColumnContextMenu(event, index))
  }

  showCellContextMenu(x: number, y: number) {
    if (!this.host.canEdit()) return
    this.host.menu.show(x, y, [
      { label: '编辑', actions: [
        ['复制', () => this.host.clipboard.copySelection()],
        ['清空内容', () => this.host.clearSelectionContents()],
      ] },
      { label: '单元格', actions: [
        ['合并单元格', () => this.host.mergeSelection()],
        ['取消合并单元格', () => this.host.unmergeSelection()],
      ] },
      { label: '固定', actions: [
        ['固定至选中行', () => this.host.freezeSelection('row')],
        ['固定至选中列', () => this.host.freezeSelection('column')],
        ['取消固定', () => this.host.setFrozenPanes(0, 0)],
      ] },
      { label: '保护', actions: this.protectionActions() },
    ])
  }

  openCellContextMenu(event: MouseEvent) {
    if (!this.host.canEdit()) return
    event.preventDefault()
    event.stopPropagation()
    this.pendingCellContext = { x: event.clientX, y: event.clientY }
    if (this.rightButtonReleased) {
      this.pendingCellContext = undefined
      const point = this.rightMouseUpPoint ?? { x: event.clientX, y: event.clientY }
      this.showCellContextMenu(point.x, point.y)
    }
  }

  attachCellListeners(td: HTMLTableCellElement, key: string, row: number, column: number) {
    td.addEventListener('mousedown', (event) => {
      if (event.target instanceof HTMLTextAreaElement) return
      if (event.button !== 0 && event.button !== 2) return
      if (event.button === 2) {
        this.rightButtonReleased = false
        this.rightDrag = { start: { row, column }, moved: false }
      } else {
        this.rightDrag = undefined
      }
      event.preventDefault()
      this.host.viewport.focus({ preventScroll: true })
      this.selecting = true
      if (event.button === 0 || !this.host.selection.isPositionSelected({ row, column })) this.host.selection.selectCell(row, column, event.shiftKey)
      this.host.refreshSelection()
    })
    td.addEventListener('mouseenter', () => {
      if (!this.selecting || this.headerSelecting) return
      if (this.rightDrag) {
        if (this.rightDrag.start.row === row && this.rightDrag.start.column === column) return
        if (!this.rightDrag.moved) {
          this.rightDrag.moved = true
          this.host.selection.mode = undefined
          this.host.selection.anchor = this.rightDrag.start
          this.host.selection.selectedKey = cellKey(this.rightDrag.start)
        }
      }
      this.host.selection.selectCell(row, column, true)
      this.host.refreshSelection()
    })
    if (this.host.canEdit()) td.addEventListener('dblclick', () => this.host.editing.start(td, key, false))
    td.addEventListener('contextmenu', (event) => this.openCellContextMenu(event))
  }

}
