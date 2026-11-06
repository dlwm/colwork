import { TableDimensions } from './tableDimensions'
import { bindBuiltInSynchronization } from './builtInSynchronization'
import { refreshValues, refreshSelection, refreshStyles, refreshCursors } from './refreshTable'
import { PointerInteraction } from './pointerInteraction'
import { TableSelection } from './tableSelection'
import { TableClipboard } from './clipboard'
import { DocumentArchive } from './documentArchive'
import type { ColworkTableOptions } from './options'
export type { ColworkTableOptions } from './options'
import { CollaborationSession } from './collaboration'
import { TableDialogs } from './dialogs'
import { CellEditor } from './cellEditor'
import { SheetDocument } from './sheetDocument'
import { defaultRows, seedDemoFormatting } from './demoData'
import { refreshFrozenBoundaries } from './overlays'
import { ContextMenu } from './context-menu'
import { buildToolbar } from './toolbar'
import { renderTable } from './renderTable'
import { CellFormatting } from './formatting'
import { createPasswordLock, verifyPasswordLock } from './passwordLock'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { WebrtcProvider } from 'y-webrtc'
import type { WebsocketProvider } from 'y-websocket'
import './colwork-table.css'
import { cellKey, containsPosition, type CellPosition, type CellRange } from './range'
import { selectionRange } from './selection'
import { COLUMN_HEADER_HEIGHT, DEFAULT_COLUMN_WIDTH, DEFAULT_ROW_HEIGHT, MAX_ZOOM, MIN_COLUMN_WIDTH, MIN_ROW_HEIGHT, MIN_ZOOM, ROW_HEADER_WIDTH } from './tableConstants'

export class ColworkTable {
  private readonly session: CollaborationSession
  private readonly doc: Y.Doc
  private readonly sheet: SheetDocument
  private readonly cells: Y.Map<string>
  private readonly styles: Y.Map<string>
  private readonly rowHeights: Y.Map<number>
  private readonly columnWidths: Y.Map<number>
  private readonly locks: Y.Map<string>
  private readonly pointer: PointerInteraction
  private readonly clipboard: TableClipboard
  private readonly selection: TableSelection
  private readonly formatting: CellFormatting
  private readonly dialogs: TableDialogs
  private destroyed = false
  private editEpoch = 0
  private frozenRows = 0
  private frozenColumns = 0
  private readonly merges: Y.Map<string>
  private readonly undoManager: Y.UndoManager
  private readonly provider?: WebrtcProvider | WebsocketProvider
  private readonly awareness: Awareness
  private readonly root: HTMLElement
  private readonly options: ColworkTableOptions
  private readonly toolbar: HTMLDivElement
  private readonly table: HTMLTableElement
  private readonly viewportResizeObserver: ResizeObserver
  private readonly viewport: HTMLDivElement
  private readonly frozenBoundaryLayer: HTMLDivElement
  private protectionMenuButton?: HTMLButtonElement
  private readonly menu: ContextMenu
  private undoButton?: HTMLButtonElement
  private redoButton?: HTMLButtonElement
  private readonly dimensions: TableDimensions
  private zoomRatio = 1
  private showGridLines = true
  private bandedRows = false
  private readOnly: boolean
  private readonly archive: DocumentArchive
  private resizing?: { axis: 'row' | 'column'; index: number; start: number; size: number; currentSize: number }
  private readonly onCellsChange = () => { if (this.expandLogicalSizeFromDocument()) this.render(); else this.refreshValues() }
  private readonly onStylesChange = () => { if (this.expandLogicalSizeFromDocument()) this.render(); else this.refreshStyles() }
  private readonly onSizesChange = () => this.render()
  private readonly onMergesChange = () => this.render()
  private readonly onLocksChange = () => {
    // Old history must not restore content underneath a newly received lock.
    this.undoManager.clear()
    if (this.editing.key && this.sheet.isCellLocked(this.editing.key)) this.editing.finish(false)
    if (this.resizing && this.sheet.isAxisLocked(this.resizing.axis, this.resizing.index)) {
      this.resizing = undefined
      this.viewport.classList.remove('is-resizing')
    }
    this.render()
  }
  private readonly onAwarenessChange = () => {
    if (!this.table) return
    if (this.expandForRemoteSelections()) this.render()
    else this.refreshCursors()
  }
  private renderFrame?: number
  private readonly onViewportScroll = () => {
    if (this.renderFrame !== undefined) return
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = undefined
      this.expandLogicalSpace()
      this.render()
    })
  }
  private readonly onViewportWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.1 : 0.9
    this.zoomRatio = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoomRatio * factor))
    this.expandLogicalSpace()
    this.render()
  }
  private readonly onViewportKeyDown = (event: KeyboardEvent) => {
    if (this.readOnly || this.editing.input) return
    const modifier = event.ctrlKey || event.metaKey
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) this.redo()
      else this.undo()
      return
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      this.redo()
      return
    }
    if (event.key !== ' ' || !this.selection.focus) return
    const key = `${this.selection.focus.row}:${this.selection.focus.column}`
    const cell = this.table.querySelector<HTMLTableCellElement>(`td[data-key="${key}"]`)
    if (!cell) return
    event.preventDefault()
    this.editing.start(cell, key)
  }
  private readonly onTableMouseDown = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('th')) event.preventDefault()
  }
  private readonly onDocumentMouseDown = (event: MouseEvent) => {
    if (!this.menu.contains(event.target as Node) && !this.protectionMenuButton?.contains(event.target as Node)) this.menu.hide()
  }
  private readonly onWindowMouseUp = (event: MouseEvent) => {
    if (this.resizing) {
      const resize = this.resizing
      this.doc.transact(() => {
        const sizes = resize.axis === 'row' ? this.rowHeights : this.columnWidths
        sizes.set(String(resize.index), resize.currentSize / this.zoomRatio)
      }, this)
      this.resizing = undefined
      this.viewport.classList.remove('is-resizing')
      return
    }
    this.pointer.release(event)
  }
  private readonly onWindowBlur = () => this.pointer.blur()
  private readonly onWindowMouseMove = (event: MouseEvent) => {
    if (this.pointer.headerSelecting && !(event.buttons & 1)) this.onWindowBlur()
    if (!this.resizing) return
    const delta = this.resizing.axis === 'row' ? event.clientY - this.resizing.start : event.clientX - this.resizing.start
    const minimum = (this.resizing.axis === 'row' ? MIN_ROW_HEIGHT : MIN_COLUMN_WIDTH) * this.zoomRatio
    const size = Math.max(minimum, this.resizing.size + delta)
    this.resizing.currentSize = size
    this.render()
  }
  private readonly onHistoryChange = () => this.refreshHistoryButtons()
  private readonly editing: CellEditor
  constructor(root: HTMLElement, options: ColworkTableOptions) {
    this.root = root
    this.options = options
    this.readOnly = options.readOnly === true
    this.dimensions = new TableDimensions(options)
    this.session = new CollaborationSession(options)
    this.doc = this.session.document
    this.awareness = this.session.awareness
    this.provider = this.session.provider
    this.sheet = new SheetDocument(this.doc, this)
    this.cells = this.sheet.cells
    this.styles = this.sheet.styles
    this.rowHeights = this.sheet.rowHeights
    this.columnWidths = this.sheet.columnWidths
    this.merges = this.sheet.merges
    this.locks = this.sheet.locks
    this.selection = new TableSelection({
      sheet: this.sheet, session: this.session, dimensions: () => ({ rows: this.rowCount, columns: this.columnCount }),
      editingKey: () => this.editing?.key, refresh: () => this.refreshSelection(),
    })
    this.formatting = new CellFormatting(this.doc, this.cells, this.styles, {
      origin: this, zoom: () => this.zoomRatio, canEdit: () => !this.readOnly && !this.destroyed && !this.selectionHasLocks(),
      selectedKey: () => this.selection.selectedKey, bounds: () => this.selection.getSelectionBounds(), render: () => this.render(),
    })
    this.dialogs = new TableDialogs({
      readOnly: () => this.readOnly, destroyed: () => this.destroyed,
      selectionFocus: () => this.selection.focus, selectionAnchor: () => this.selection.anchor,
      restoreSelection: (anchor, focus) => { this.selection.anchor = anchor; this.selection.focus = focus },
      root: () => this.root, locks: this.locks, hideMenu: () => this.menu.hide(),
      setSelectionLocked: (locked, password) => this.setSelectionLocked(locked, password),
    })
    const useWebrtc = options.transport === 'webrtc'
    this.log(`room:${options.room}`)
    this.archive = new DocumentArchive(this.sheet, this.awareness, this.provider, options.room, message => this.log(message), !!options.onLog)
    this.awareness.on('change', this.onAwarenessChange)
    if (useWebrtc && this.provider) this.archive.inspectConnections()

    const shell = document.createElement('section')
    shell.className = 'colwork-table'
    this.viewport = document.createElement('div')
    this.viewport.className = 'colwork-table__viewport'
    this.menu = new ContextMenu(this.viewport, () => this.protectionMenuButton?.setAttribute('aria-expanded', 'false'))
    this.viewport.addEventListener('scroll', this.onViewportScroll)
    this.viewport.addEventListener('wheel', this.onViewportWheel, { passive: false })
    this.viewport.tabIndex = 0
    this.viewport.addEventListener('keydown', this.onViewportKeyDown)
    window.addEventListener('mouseup', this.onWindowMouseUp)
    window.addEventListener('mousemove', this.onWindowMouseMove)
    window.addEventListener('blur', this.onWindowBlur)
    document.addEventListener('mousedown', this.onDocumentMouseDown)
    this.table = document.createElement('table')
    this.editing = new CellEditor({
      table: this.table, canEdit: key => !this.readOnly && !this.destroyed && !this.sheet.isCellLocked(key),
      read: key => this.cells.get(key), write: (key, value) => this.doc.transact(() => this.cells.set(key, value), this),
      applyStyle: (element, key) => this.formatting.applyStyle(element, key), displayValue: key => this.formatting.displayValue(key),
      announce: cursor => this.selection.sendAwareness(cursor), focus: () => this.selection.focus,
      clearEditingPresence: () => { if (!this.destroyed) this.session.finishEditing() },
      changed: state => this.options.onEditingChange?.(state),
      refresh: () => { this.refreshSelection(); this.refreshCursors() }, render: () => { if (!this.destroyed) this.render() },
    })
    this.clipboard = new TableClipboard({
      sheet: this.sheet, selection: this.selection, editing: this.editing, formatting: this.formatting,
      canEdit: () => !this.readOnly && !this.destroyed, dimensions: () => ({ rows: this.rowCount, columns: this.columnCount }),
      render: () => this.render(), origin: this,
    })
    this.pointer = new PointerInteraction({
      selection: this.selection, menu: this.menu, viewport: this.viewport, editing: this.editing,
      dialogs: this.dialogs, clipboard: this.clipboard, canEdit: () => !this.readOnly && !this.destroyed,
      freezeSelection: axis => this.freezeSelection(axis), setFrozenPanes: (rows, columns) => this.setFrozenPanes(rows, columns),
      modifyAxis: (axis, index, amount) => this.modifyAxis(axis, index, amount),
      deleteRows: () => this.deleteRows(), deleteColumns: () => this.deleteColumns(),
      mergeSelection: () => this.mergeSelection(), unmergeSelection: () => this.unmergeSelection(),
      clearSelectionContents: () => this.clearSelectionContents(), refreshSelection: () => this.refreshSelection(),
    })
    this.table.addEventListener('mousedown', this.onTableMouseDown)
    this.viewport.addEventListener('copy', this.clipboard.onCopy, true)
    this.viewport.addEventListener('paste', this.clipboard.onPaste, true)
    this.viewport.append(this.table)
    this.frozenBoundaryLayer = document.createElement('div')
    this.frozenBoundaryLayer.className = 'colwork-table__frozen-boundaries'
    this.frozenBoundaryLayer.setAttribute('aria-hidden', 'true')
    const owner = this
    const toolbar = buildToolbar({
      readOnly: this.readOnly, view: {
        get bandedRows() { return owner.bandedRows }, set bandedRows(value) { owner.bandedRows = value },
        get showGridLines() { return owner.showGridLines }, set showGridLines(value) { owner.showGridLines = value },
      },
      undo: () => this.undo(), redo: () => this.redo(),
      mergeSelection: () => this.mergeSelection(), unmergeSelection: () => this.unmergeSelection(),
      hideContextMenu: () => this.menu.hide(), showContextMenu: (x, y, groups) => this.menu.show(x, y, groups),
      protectionActions: () => this.pointer.protectionActions(), freezeSelection: axis => this.freezeSelection(axis),
      setFrozenPanes: (rows, columns) => this.setFrozenPanes(rows, columns), render: () => this.render(),
      setStyle: (format, value) => this.formatting.setStyle(format, value), toggleFormat: format => this.formatting.toggleFormat(format),
      clearFormatting: () => this.formatting.clearFormatting(), toggleBorder: mode => this.formatting.toggleBorder(mode),
    })
    this.toolbar = toolbar.toolbar
    this.undoButton = toolbar.undoButton
    this.redoButton = toolbar.redoButton
    this.protectionMenuButton = toolbar.protectionButton
    shell.append(this.toolbar, this.viewport, this.frozenBoundaryLayer)
    root.replaceChildren(shell)

    const shouldSeed = !this.session.external && !this.readOnly && !options.snapshot && !options.updates?.length
    const shouldSeedDemo = shouldSeed && this.cells.size === 0 && this.locks.size === 0
    if (shouldSeed && !options.initializeAfterSync) this.sheet.seed(options.rows ?? defaultRows)
    if (shouldSeedDemo && !options.initializeAfterSync) seedDemoFormatting(this.sheet)
    this.expandLogicalSizeFromDocument()
    this.undoManager = new Y.UndoManager([this.cells, this.styles, this.rowHeights, this.columnWidths, this.merges], { captureTimeout: 500, trackedOrigins: this.session.external ? new Set([this]) : new Set([null, this]) })
    this.undoManager.on('stack-item-added', this.onHistoryChange)
    this.undoManager.on('stack-item-popped', this.onHistoryChange)
    this.undoManager.on('stack-cleared', this.onHistoryChange)
    this.render()
    this.refreshHistoryButtons()
    this.cells.observe(this.onCellsChange)
    this.styles.observe(this.onStylesChange)
    this.rowHeights.observe(this.onSizesChange)
    this.columnWidths.observe(this.onSizesChange)
    this.merges.observe(this.onMergesChange)
    this.locks.observe(this.onLocksChange)
    this.viewportResizeObserver = new ResizeObserver(() => refreshFrozenBoundaries(this.frozenBoundaryLayer, this.viewport, this.frozenRows, this.frozenColumns, this.rowHeaderWidth, this.columnHeaderHeight, (axis, index) => axis === 'row' ? this.getRowHeight(index) : this.getColumnWidth(index)))
    this.viewportResizeObserver.observe(this.viewport)
    bindBuiltInSynchronization(this.session, options, this.sheet, shouldSeed, {
      canEdit: () => !this.readOnly && !this.destroyed, log: message => this.log(message),
      inspect: () => this.archive.inspectConnections(), clearHistory: () => this.undoManager.clear(), render: () => this.render(),
    })
  }

  private log(message: string) {
    this.options.onLog?.(`${new Date().toLocaleTimeString()} ${message}`)
  }

  private undo() {
    if (this.readOnly || !this.undoManager.canUndo()) return
    if (this.editing.input) this.editing.finish(true)
    this.undoManager.undo()
  }

  private redo() {
    if (this.readOnly || !this.undoManager.canRedo()) return
    if (this.editing.input) this.editing.finish(true)
    this.undoManager.redo()
  }

  private refreshHistoryButtons() {
    if (this.undoButton) this.undoButton.disabled = this.readOnly || !this.undoManager.canUndo()
    if (this.redoButton) this.redoButton.disabled = this.readOnly || !this.undoManager.canRedo()
  }

  /** Changes local editing affordances. Hosts enforce actual document permissions. */
  setReadOnly(readOnly: boolean) {
    if (this.destroyed || this.readOnly === readOnly) return
    this.readOnly = readOnly
    this.editEpoch++
    this.editing.finish(false)
    this.resizing = undefined
    this.viewport.classList.remove('is-resizing')
    this.pointer.cancel()
    this.dialogs.close()
    this.menu.hide()
    this.toolbar.hidden = readOnly
    this.undoManager.clear()
    this.refreshHistoryButtons()
    this.render()
  }

  /** Explicitly commits the active cell draft before a host publishes or exports. */
  commitEditing() { if (!this.destroyed) this.editing.finish(true) }

  /** Discards an active draft while preserving the current shared document value. */
  cancelEditing() { if (!this.destroyed) this.editing.finish(false) }

  getYjsSnapshot() { return this.archive.snapshot() }

  getYjsUpdateLog() { return this.archive.updateLog() }
  /** Freeze a leading prefix in this local view. */
  setFrozenPanes(rows: number, columns: number) {
    if (this.destroyed) return false
    if (![rows, columns].every((value) => Number.isInteger(value) && value >= 0)) {
      throw new RangeError('Frozen row and column counts must be non-negative integers')
    }
    const nextRows = Math.min(rows, this.rowCount - 1)
    const nextColumns = Math.min(columns, this.columnCount - 1)
    if (this.sheet.hasPartialMerge('row', 0, nextRows - 1) || this.sheet.hasPartialMerge('column', 0, nextColumns - 1)) {
      this.dialogs.showLockMessage('当前选择包含不完整的合并块，无法固定，请选择完整的合并块')
      return false
    }
    this.editing.finish(true)
    this.frozenRows = nextRows
    this.frozenColumns = nextColumns
    this.dialogs.closeLockMessage()
    this.render()
    return true
  }

  private crossesFrozenBoundary(range: CellRange) {
    return (range.start.row < this.frozenRows && range.end.row >= this.frozenRows)
      || (range.start.column < this.frozenColumns && range.end.column >= this.frozenColumns)
  }

  private freezeSelection(axis: 'row' | 'column') {
    if (!this.selection.focus) return
    const range = selectionRange(this.selection.anchor, this.selection.focus)
    // Validate the selected collection as well as the resulting leading prefix.
    if (this.sheet.hasPartialMerge(axis, range.start[axis], range.end[axis])) {
      this.dialogs.showLockMessage('当前选择包含不完整的合并块，无法固定，请选择完整的合并块')
      return
    }
    this.setFrozenPanes(axis === 'row' ? range.end.row + 1 : this.frozenRows,
      axis === 'column' ? range.end.column + 1 : this.frozenColumns)
  }

  private selectionHasLocks() {
    return this.sheet.rangeHasLocks(selectionRange(this.selection.anchor, this.selection.focus))
  }

  async setSelectionLocked(locked: boolean, password?: string): Promise<void> {
    if (this.readOnly || this.destroyed || !this.selection.focus) return
    this.editing.finish(true)
    const expanded = this.sheet.expandSelectionToMerges(
      this.selection.anchor ?? this.selection.focus, this.selection.focus)
    const range = selectionRange(expanded.anchor, expanded.focus)
    const keys: string[] = []
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      for (let column = range.start.column; column <= range.end.column; column += 1) keys.push(cellKey({ row, column }))
    }
    const protectedRecords = [...new Set(keys.map(key => this.locks.get(key)).filter((value): value is string => value !== undefined && value !== '1'))]
    // Re-locking must never replace a password verifier with an unprotected lock.
    if (locked && protectedRecords.length) throw new Error('选区包含密码锁定单元格，请先用原密码解锁')
    const revision = this.archive.revision
    const epoch = this.editEpoch
    let record = '1'
    if (locked && password !== undefined) record = await createPasswordLock(password)
    if (!locked && protectedRecords.length) {
      if (!password) throw new Error('请输入解锁密码')
      for (const protectedRecord of protectedRecords) {
        if (!await verifyPasswordLock(protectedRecord, password)) throw new Error('密码不正确，选区未解锁')
      }
    }
    // Crypto is asynchronous: reject concurrent document edits rather than applying
    // a verified result to changed locks or coordinates. Selection itself is captured.
    if (this.destroyed || this.readOnly || epoch !== this.editEpoch) return
    if (revision !== this.archive.revision) throw new Error('表格内容或锁定状态已变化，请重试')
    this.doc.transact(() => {
      keys.forEach(key => {
        if (locked) this.locks.set(key, record)
        else this.locks.delete(key)
      })
    }, this)
  }

  private get rowCount() { return this.dimensions.rows }
  private get columnCount() { return this.dimensions.columns }
  private get rowHeaderWidth() { return ROW_HEADER_WIDTH * this.zoomRatio }
  private get columnHeaderHeight() { return COLUMN_HEADER_HEIGHT * this.zoomRatio }

  private getRowHeight(row: number) {
    if (this.resizing?.axis === 'row' && this.resizing.index === row) return this.resizing.currentSize
    return Math.max(MIN_ROW_HEIGHT, this.rowHeights.get(String(row)) ?? DEFAULT_ROW_HEIGHT) * this.zoomRatio
  }

  private getColumnWidth(column: number) {
    if (this.resizing?.axis === 'column' && this.resizing.index === column) return this.resizing.currentSize
    return Math.max(MIN_COLUMN_WIDTH, this.columnWidths.get(String(column)) ?? DEFAULT_COLUMN_WIDTH) * this.zoomRatio
  }

  private beginResize(axis: 'row' | 'column', index: number, event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (event.button !== 0 || this.readOnly || this.sheet.isAxisLocked(axis, index)) return
    this.editing.finish(true)
    this.pointer.selecting = false
    this.pointer.headerSelecting = undefined
    this.resizing = {
      axis,
      index,
      start: axis === 'row' ? event.clientY : event.clientX,
      size: axis === 'row' ? this.getRowHeight(index) : this.getColumnWidth(index),
      currentSize: axis === 'row' ? this.getRowHeight(index) : this.getColumnWidth(index),
    }
    this.viewport.classList.add('is-resizing')
  }

  private addResizeHandle(element: HTMLElement, axis: 'row' | 'column', index: number) {
    const handle = document.createElement('span')
    handle.className = `colwork-table__resize-handle colwork-table__resize-handle--${axis}`
    handle.addEventListener('mousedown', (event) => this.beginResize(axis, index, event))
    element.append(handle)
  }

  private mergeSelection() {
    if (this.readOnly || this.selectionHasLocks()) return
    const range = selectionRange(this.selection.anchor, this.selection.focus)
    if (range.start.row === range.end.row && range.start.column === range.end.column) return
    if (this.crossesFrozenBoundary(range)) {
      this.dialogs.showLockMessage('合并范围同时包含固定和非固定区域，无法合并，请调整选区或取消固定')
      return
    }
    this.dialogs.closeLockMessage()
    this.doc.transact(() => {
      this.sheet.getMergeRanges().forEach((existing) => {
        if (containsPosition(range, existing.start) || containsPosition(existing, range.start)) this.merges.delete(this.sheet.mergeKey(existing))
      })
      this.merges.set(this.sheet.mergeKey(range), '1')
    }, this)
  }

  private unmergeSelection() {
    if (this.readOnly || this.selectionHasLocks()) return
    const range = selectionRange(this.selection.anchor, this.selection.focus)
    this.doc.transact(() => this.sheet.getMergeRanges().forEach((existing) => {
      if (containsPosition(range, existing.start) || containsPosition(existing, range.start)) this.merges.delete(this.sheet.mergeKey(existing))
    }), this)
  }

  private modifyAxis(axis: 'row' | 'column', index: number, amount: number, removeCount = 0) {
    if (this.readOnly || amount === 0 || this.sheet.isAxisLocked(axis, index, true)) return
    this.sheet.modifyAxis(axis, index, amount, removeCount)
    if (axis === 'row') this.dimensions.rows = Math.max(1, this.dimensions.rows + amount)
    else this.dimensions.columns = Math.max(1, this.dimensions.columns + amount)
    this.render()
  }

  private deleteRows() {
    const range = selectionRange(this.selection.anchor, this.selection.focus)
    const count = Math.min(range.end.row - range.start.row + 1, this.rowCount - 1)
    this.modifyAxis('row', range.start.row, -count, count)
  }

  private deleteColumns() {
    const range = selectionRange(this.selection.anchor, this.selection.focus)
    const count = Math.min(range.end.column - range.start.column + 1, this.columnCount - 1)
    this.modifyAxis('column', range.start.column, -count, count)
  }

  private expandLogicalSpace() { return this.dimensions.expandViewport(this.viewport, this.selection) }

  private expandForRemoteSelections() { return this.dimensions.expandRemote(this.awareness) }

  private clearSelectionContents() {
    if (this.readOnly || this.selectionHasLocks()) return
    const range = selectionRange(this.selection.anchor, this.selection.focus)
    this.doc.transact(() => {
      for (let row = range.start.row; row <= range.end.row; row += 1) {
        for (let column = range.start.column; column <= range.end.column; column += 1) this.cells.delete(cellKey({ row, column }))
      }
    }, this)
  }


  private expandLogicalSizeFromDocument() { return this.dimensions.expandDocument(this.sheet) }

  private render() {
    if (this.editing.input) this.editing.finish(true)
    this.expandLogicalSizeFromDocument()
    this.frozenRows = Math.min(this.frozenRows, this.rowCount - 1)
    this.frozenColumns = Math.min(this.frozenColumns, this.columnCount - 1)
    const invalidRows = this.sheet.hasPartialMerge('row', 0, this.frozenRows - 1)
    const invalidColumns = this.sheet.hasPartialMerge('column', 0, this.frozenColumns - 1)
    if (invalidRows || invalidColumns) {
      if (invalidRows) this.frozenRows = 0
      if (invalidColumns) this.frozenColumns = 0
      this.dialogs.showLockMessage('合并区域已变化，已取消与合并块冲突的固定行列')
    }
    renderTable({
      table: this.table, viewport: this.viewport, rowCount: this.rowCount, columnCount: this.columnCount,
      frozenRows: this.frozenRows, frozenColumns: this.frozenColumns, zoomRatio: this.zoomRatio,
      rowHeaderWidth: this.rowHeaderWidth, columnHeaderHeight: this.columnHeaderHeight,
      bandedRows: this.bandedRows, showGridLines: this.showGridLines, readOnly: this.readOnly,
      getRowHeight: row => this.getRowHeight(row), getColumnWidth: column => this.getColumnWidth(column),
      getMergeRanges: () => this.sheet.getMergeRanges(), isCellLocked: (key, merge) => this.sheet.isCellLocked(key, merge),
      isCellPasswordLocked: (key, merge) => this.sheet.isCellPasswordLocked(key, merge), displayValue: key => this.formatting.displayValue(key),
      applyStyle: (element, key) => this.formatting.applyStyle(element, key),
      addResizeHandle: (element, axis, index) => this.addResizeHandle(element, axis, index),
      addHeaderSelection: (element, axis, index) => this.pointer.addHeaderSelection(element, axis, index),
      selectRange: (anchor, focus, mode) => this.selection.selectRange(anchor, focus, mode),
      attachCellListeners: (cell, key, row, column) => this.pointer.attachCellListeners(cell, key, row, column),
    })
    refreshFrozenBoundaries(this.frozenBoundaryLayer, this.viewport, this.frozenRows, this.frozenColumns, this.rowHeaderWidth, this.columnHeaderHeight, (axis, index) => axis === 'row' ? this.getRowHeight(index) : this.getColumnWidth(index))
    this.refreshSelection()
    this.refreshCursors()
  }

  private refreshValues() { refreshValues(this.refreshView()) }
  private refreshSelection() { refreshSelection(this.refreshView()) }
  private refreshCursors() { refreshCursors(this.refreshView()) }
  private refreshStyles() { refreshStyles(this.refreshView()) }
  private refreshView() {
    return { table: this.table, viewport: this.viewport, editingKey: this.editing?.key, formatting: this.formatting,
      selection: this.selection, awareness: this.awareness, userColor: this.options.userColor,
      rowCount: this.rowCount, columnCount: this.columnCount,
      size: (axis: 'row' | 'column', index: number) => axis === 'row' ? this.getRowHeight(index) : this.getColumnWidth(index) }
  }

  destroy() {
    if (this.destroyed) return
    if (!this.session.external) this.editing.finish(true)
    this.destroyed = true
    this.viewportResizeObserver.disconnect()
    this.dialogs.close()
    this.editing.finish(false)
    this.archive.destroy()
    this.awareness.off('change', this.onAwarenessChange)
    this.cells.unobserve(this.onCellsChange)
    this.styles.unobserve(this.onStylesChange)
    this.rowHeights.unobserve(this.onSizesChange)
    this.columnWidths.unobserve(this.onSizesChange)
    this.merges.unobserve(this.onMergesChange)
    this.locks.unobserve(this.onLocksChange)
    this.undoManager.off('stack-item-added', this.onHistoryChange)
    this.undoManager.off('stack-item-popped', this.onHistoryChange)
    this.undoManager.off('stack-cleared', this.onHistoryChange)
    this.viewport.removeEventListener('scroll', this.onViewportScroll)
    this.viewport.removeEventListener('wheel', this.onViewportWheel)
    this.viewport.removeEventListener('keydown', this.onViewportKeyDown)
    this.viewport.removeEventListener('copy', this.clipboard.onCopy, true)
    this.viewport.removeEventListener('paste', this.clipboard.onPaste, true)
    this.table.removeEventListener('mousedown', this.onTableMouseDown)
    window.removeEventListener('mouseup', this.onWindowMouseUp)
    window.removeEventListener('mousemove', this.onWindowMouseMove)
    window.removeEventListener('blur', this.onWindowBlur)
    document.removeEventListener('mousedown', this.onDocumentMouseDown)
    this.menu.hide()
    if (this.renderFrame !== undefined) cancelAnimationFrame(this.renderFrame)
    this.undoManager.destroy()
    this.sheet.destroy()
    this.session.destroy()
    this.root.replaceChildren()
  }
}
