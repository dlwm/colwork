import { TableDimensions } from './tableDimensions'
import { bindBuiltInSynchronization } from './builtInSynchronization'
import { refreshValues, refreshSelection, refreshStyles, refreshCursors } from './refreshTable'
import { PointerInteraction } from './pointerInteraction'
import { TableSelection } from './tableSelection'
import { TableClipboard } from './clipboard'
import { DocumentArchive } from './documentArchive'
import type { ColworkRowView, ColworkTableOptions, ColworkViewPolicy } from './options'
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
import { TableWatermark } from './tableWatermark'
import type { ProjectedMap, SheetCoordinates } from './sheetCoordinates'
import { parseCellKey } from './model-schema'
import { openRowViewDialog } from './rowViewDialog'
import { encodeCellImage, readCellImage } from './cellImage'
import { renderCellContent } from './cellContent'
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
  private axes: SheetCoordinates['axes']
  private rowView: ColworkRowView = {}
  private rowViewDialog?: HTMLDialogElement
  private readonly imageUploads = new Map<string, symbol>()
  private imagePicker?: HTMLInputElement
  private readonly cells: ProjectedMap<string>
  private readonly styles: ProjectedMap<string>
  private readonly rowHeights: ProjectedMap<number>
  private readonly columnWidths: ProjectedMap<number>
  private readonly locks: ProjectedMap<string>
  private readonly pointer: PointerInteraction
  private readonly clipboard: TableClipboard
  private readonly selection: TableSelection
  private readonly formatting: CellFormatting
  private readonly dialogs: TableDialogs
  private destroyed = false
  private editEpoch = 0
  private frozenRows = 0
  private frozenColumns = 0
  private readonly merges: ProjectedMap<string>
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
  #allowExport = true
  readonly #watermark: TableWatermark
  private readonly archive: DocumentArchive
  private resizing?: { axis: 'row' | 'column'; index: number; start: number; size: number; currentSize: number }
  private readonly onCellsChange = () => {
    if (this.axes !== this.sheet.coordinates.axes) return
    if (this.sheet.coordinates.hasRowOrder) { this.refreshRowOrder(); this.render() }
    else if (this.expandLogicalSizeFromDocument()) this.render()
    else this.refreshValues()
  }
  private readonly onStylesChange = () => { if (this.expandLogicalSizeFromDocument()) this.render(); else this.refreshStyles() }
  private readonly onFormulaDependencies = (transaction: Y.Transaction) => {
    const changed = new Set<unknown>(transaction.changed.keys())
    if (!changed.size || changed.has(this.cells.raw)) return
    if ([...this.doc.share].some(([name, type]) => changed.has(type) &&
      (name === 'colwork-workbook' || name.startsWith('colwork-sheet:') || name === 'cells' || name.endsWith('-edits')))) {
      if (this.sheet.coordinates.hasRowOrder) { this.refreshRowOrder(); this.render() }
      else this.refreshValues()
    }
  }
  private readonly onSizesChange = () => this.render()
  private readonly onMergesChange = () => {
    if (this.axes !== this.sheet.coordinates.axes) return
    if (this.sheet.coordinates.hasRowOrder) this.refreshRowOrder()
    this.render()
  }
  private readonly onAxesChange = () => {
    const coordinates = this.sheet.coordinates
    const previous = this.axes
    const next = coordinates.axes
    if (previous === next) return
    const selection = this.selection
    const selectedPosition = selection.selectedKey ? parseCellKey(selection.selectedKey) : undefined
    const priorRows = new Map([selection.anchor, selection.focus, selectedPosition].flatMap(position =>
      position ? [[position.row, coordinates.canonicalRow(position.row)] as const] : []))
    const wasOrdered = coordinates.hasRowOrder
    this.axes = next
    if (wasOrdered) {
      const columnOf = (column: number) => next.column.positionOf(previous.column.idAt(column))
      const sort = this.rowView.sort
      const column = sort && columnOf(sort.column)
      this.rowView = {
        headerRows: this.rowView.headerRows,
        sort: sort && column !== undefined ? { ...sort, column } : undefined,
        filters: this.rowView.filters?.flatMap(filter => {
          const mapped = columnOf(filter.column)
          return mapped === undefined ? [] : [{ ...filter, column: mapped }]
        }),
      }
      try { this.sheet.applyRowView(this.rowView) } catch { this.rowView = {}; this.sheet.applyRowView({}) }
    }
    this.dimensions.rows = Math.max(1, this.dimensions.rows + next.row.delta - previous.row.delta)
    this.dimensions.columns = Math.max(1, this.dimensions.columns + next.column.delta - previous.column.delta)
    this.expandLogicalSizeFromDocument()
    const remap = (position: CellPosition | undefined) => {
      if (!position) return undefined
      const priorRow = priorRows.get(position.row)
      const canonical = priorRow === undefined ? undefined : next.row.positionOf(previous.row.idAt(priorRow))
      const row = canonical === undefined ? undefined : coordinates.visualRow(canonical)
      if (row === undefined && wasOrdered) return undefined
      return {
        row: row ?? Math.min(position.row, this.rowCount - 1),
        column: next.column.positionOf(previous.column.idAt(position.column)) ?? Math.min(position.column, this.columnCount - 1),
      }
    }
    const selected = remap(selectedPosition)
    selection.anchor = remap(selection.anchor)
    selection.focus = remap(selection.focus)
    selection.selectedKey = selected && cellKey(selected)
    if (selection.anchor && selection.focus) {
      if (selection.mode === 'row' || selection.mode === 'all') {
        selection.anchor.column = 0
        selection.focus.column = this.columnCount - 1
      }
      if (selection.mode === 'column' || selection.mode === 'all') {
        selection.anchor.row = 0
        selection.focus.row = this.rowCount - 1
      }
    }
    this.editEpoch++
    this.resizing = undefined
    this.viewport.classList.remove('is-resizing')
    this.pointer.cancel()
    this.menu.hide()
    this.dialogs.close()
    this.render()
    if (selection.focus) selection.sendAwareness(selection.focus)
    else if (wasOrdered) selection.updateAwareness({ cursor: undefined, editing: null })
  }
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
    this.sheet = new SheetDocument(this.doc, this, options.sheetId)
    this.axes = this.sheet.coordinates.axes
    this.dimensions.rows = Math.max(1, this.dimensions.rows + this.axes.row.delta)
    this.dimensions.columns = Math.max(1, this.dimensions.columns + this.axes.column.delta)
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
    this.formatting = new CellFormatting(this.doc, this.styles, {
      origin: this, zoom: () => this.zoomRatio, canEdit: () => !this.readOnly && !this.destroyed && !this.selectionHasLocks(),
      readValue: key => this.sheet.displayCell(key),
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
      id: key => this.sheet.coordinates.cellId(key), position: id => this.sheet.coordinates.cellKey(id),
      table: this.table, canEdit: key => !this.readOnly && !this.destroyed && !this.sheet.isCellLocked(key),
      read: key => this.sheet.readCell(key), write: (key, value) => this.doc.transact(() => this.sheet.writeCell(key, value), this),
      applyStyle: (element, key) => this.formatting.applyStyle(element, key), renderContent: this.renderContent,
      announce: cursor => this.selection.sendAwareness(cursor), focus: () => this.selection.focus,
      clearEditingPresence: () => { if (!this.destroyed) this.session.finishEditing() },
      changed: state => this.options.onEditingChange?.(state),
      refresh: () => { this.refreshSelection(); this.refreshCursors() }, render: () => { if (!this.destroyed) this.render() },
    })
    this.clipboard = new TableClipboard({
      sheet: this.sheet, selection: this.selection, editing: this.editing, formatting: this.formatting,
      canEdit: () => !this.readOnly && !this.destroyed, dimensions: () => ({ rows: this.rowCount, columns: this.columnCount }),
      pasteImage: options.images?.upload ? file => this.uploadFromView(file) : undefined,
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
      openRowView: () => this.openRowView(),
      chooseImage: options.images?.upload ? () => this.chooseImage() : undefined,
      setStyle: (format, value) => this.formatting.setStyle(format, value), toggleFormat: format => this.formatting.toggleFormat(format),
      clearFormatting: () => this.formatting.clearFormatting(), toggleBorder: mode => this.formatting.toggleBorder(mode),
    })
    this.toolbar = toolbar.toolbar
    this.undoButton = toolbar.undoButton
    this.redoButton = toolbar.redoButton
    this.protectionMenuButton = toolbar.protectionButton
    shell.append(this.toolbar, this.viewport, this.frozenBoundaryLayer)
    root.replaceChildren(shell)
    this.#watermark = new TableWatermark(shell)
    this.#applyViewPolicy(options.viewPolicy ?? {})

    const shouldSeed = !this.session.external && !this.readOnly && !options.snapshot && !options.updates?.length
    const shouldSeedDemo = shouldSeed && this.cells.size === 0 && this.locks.size === 0
    if (shouldSeed && !options.initializeAfterSync) this.sheet.seed(options.rows ?? defaultRows)
    if (shouldSeedDemo && !options.initializeAfterSync) seedDemoFormatting(this.sheet)
    this.expandLogicalSizeFromDocument()
    const { row, column } = this.sheet.coordinates.edits
    this.undoManager = new Y.UndoManager([this.cells.raw, this.styles.raw, this.rowHeights.raw, this.columnWidths.raw, this.merges.raw, row, column], { captureTimeout: 500, trackedOrigins: this.session.external ? new Set([this]) : new Set([null, this]) })
    this.undoManager.on('stack-item-added', this.onHistoryChange)
    this.undoManager.on('stack-item-popped', this.onHistoryChange)
    this.undoManager.on('stack-cleared', this.onHistoryChange)
    this.render()
    this.refreshHistoryButtons()
    this.cells.raw.observe(this.onCellsChange)
    this.doc.on('afterTransaction', this.onFormulaDependencies)
    this.styles.raw.observe(this.onStylesChange)
    this.rowHeights.raw.observe(this.onSizesChange)
    this.columnWidths.raw.observe(this.onSizesChange)
    this.merges.raw.observe(this.onMergesChange)
    this.locks.raw.observe(this.onLocksChange)
    row.observe(this.onAxesChange)
    column.observe(this.onAxesChange)
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

  /** Replaces the entire local view policy. Omitted fields use their defaults. */
  setViewPolicy(policy: ColworkViewPolicy) {
    if (!this.destroyed) this.#applyViewPolicy(policy)
  }

  #applyViewPolicy(policy: ColworkViewPolicy) {
    this.#allowExport = policy.allowExport === undefined || policy.allowExport === true
    this.#watermark.setText(policy.watermark)
  }

  canExport() { return this.#allowExport }

  /** Uploads through the host, then writes its resource reference into the selected cell. */
  async insertImage(file: File, position = this.selectedImagePosition()) {
    const upload = this.options.images?.upload
    if (!upload) throw new Error('请先配置图片上传接口')
    if (this.readOnly || this.destroyed) return false
    if (!position || !Number.isSafeInteger(position.row) || !Number.isSafeInteger(position.column)
      || position.row < 0 || position.column < 0 || position.row >= this.rowCount || position.column >= this.columnCount) {
      throw new RangeError('请先选中要插入图片的单元格')
    }
    if (!file.size || (file.type && !/^image\/(png|jpeg|gif|webp)$/i.test(file.type))) throw new TypeError('请选择 PNG、JPEG、GIF 或 WebP 图片')
    const merge = this.sheet.getMergeRanges().find(range => containsPosition(range, position))
    const key = cellKey(merge?.start ?? position)
    const id = this.sheet.coordinates.cellId(key)
    if (!id || this.sheet.isCellLocked(key)) return false
    this.commitEditing()
    const original = this.cells.raw.get(id)
    const request = Symbol()
    this.imageUploads.set(id, request)
    try {
      const value = encodeCellImage(await upload(file))
      const current = this.sheet.coordinates.cellKey(id)
      if (this.imageUploads.get(id) !== request || !current || this.readOnly || this.destroyed
        || this.sheet.isCellLocked(current) || this.cells.raw.get(id) !== original) return false
      this.undoManager.stopCapturing()
      this.doc.transact(() => this.cells.raw.set(id, value), this)
      this.undoManager.stopCapturing()
      return true
    } finally {
      if (this.imageUploads.get(id) === request) this.imageUploads.delete(id)
    }
  }

  private selectedImagePosition() {
    return this.selection.selectedKey ? parseCellKey(this.selection.selectedKey) : this.selection.focus
  }

  private chooseImage() {
    if (!this.selectedImagePosition()) {
      this.dialogs.showLockMessage('请先选中要插入图片的单元格')
      return
    }
    if (!this.imagePicker) {
      const input = this.root.ownerDocument.createElement('input')
      input.type = 'file'
      input.accept = 'image/png,image/jpeg,image/gif,image/webp'
      input.hidden = true
      input.setAttribute('aria-label', '选择图片')
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        input.value = ''
        if (file) this.uploadFromView(file)
      })
      this.root.append(input)
      this.imagePicker = input
    }
    this.imagePicker.click()
  }

  private uploadFromView(file: File) {
    void this.insertImage(file).then(inserted => {
      if (!inserted && !this.destroyed) this.dialogs.showLockMessage('当前单元格不可编辑或已变化，未插入图片')
    }, error => {
      if (!this.destroyed) this.dialogs.showLockMessage(error instanceof Error ? error.message : '图片上传失败')
    })
  }

  private readonly renderContent = (element: HTMLElement, key: string) => {
    const image = readCellImage(this.cells.get(key))
    renderCellContent(element, this.formatting.displayValue(key), image, this.options.images?.resolveUrl)
  }

  getRowView(): ColworkRowView { return structuredClone(this.rowView) }

  setRowView(view: ColworkRowView) {
    if (this.destroyed) return
    const filters = (view.filters ?? []).filter(filter => filter.contains.trim()).map(filter => ({ ...filter }))
    const columns = [...filters.map(filter => filter.column), ...(view.sort ? [view.sort.column] : [])]
    if (columns.some(column => !Number.isSafeInteger(column) || column < 0 || column >= this.columnCount)
      || (view.headerRows !== undefined && (!Number.isSafeInteger(view.headerRows) || view.headerRows < 0))
      || (view.sort && !['asc', 'desc'].includes(view.sort.direction))) throw new RangeError('排序或筛选条件无效')
    this.commitEditing()
    const next = { sort: view.sort && { ...view.sort }, filters, headerRows: view.headerRows }
    try { this.sheet.applyRowView(next) } catch (error) { this.sheet.applyRowView(this.rowView); throw error }
    this.rowView = next
    this.selection.anchor = this.selection.focus = undefined
    this.selection.selectedKey = this.selection.pendingCursor = undefined
    this.selection.updateAwareness({ cursor: undefined, editing: null })
    this.pointer.cancel()
    this.viewport.scrollTop = 0
    this.render()
  }

  openRowView() {
    if (this.destroyed || this.rowViewDialog?.open) return
    this.rowViewDialog = openRowViewDialog(this.root, this.getRowView(), this.selection.focus?.column ?? 0, this.columnCount,
      view => this.setRowView(view))
  }

  private refreshRowOrder() {
    const coordinates = this.sheet.coordinates
    const focus = this.selection.focus && coordinates.cellId(cellKey(this.selection.focus))
    const anchor = this.selection.anchor && coordinates.cellId(cellKey(this.selection.anchor))
    try { this.sheet.applyRowView(this.rowView) } catch { this.rowView = {}; this.sheet.applyRowView({}) }
    this.selection.focus = focus ? coordinates.cellPosition(focus) : undefined
    this.selection.anchor = anchor ? coordinates.cellPosition(anchor) : this.selection.focus
    this.selection.selectedKey = this.selection.focus && cellKey(this.selection.focus)
  }

  #assertExportAllowed() {
    if (!this.#allowExport) throw new DOMException('Export is disabled by the view policy', 'NotAllowedError')
  }

  getYjsSnapshot() {
    this.#assertExportAllowed()
    return this.archive.snapshot()
  }

  getYjsUpdateLog() {
    this.#assertExportAllowed()
    return this.archive.updateLog()
  }
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

  private get rowCount() { return this.sheet.coordinates.visibleRowCount(this.dimensions.rows) }
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
    if (this.sheet.coordinates.hasRowOrder && range.start.row !== range.end.row) return
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
    if (this.sheet.coordinates.hasRowOrder) {
      this.dialogs.showLockMessage('请先清除个人排序筛选，再增删行列')
      return
    }
    if (this.readOnly || amount === 0 || this.sheet.isAxisLocked(axis, index, true)) return
    this.editing.finish(true)
    this.undoManager.stopCapturing()
    this.sheet.modifyAxis(axis, index, amount, removeCount)
    this.undoManager.stopCapturing()
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

  private expandLogicalSpace() { if (!this.sheet.coordinates.hasRowOrder) this.dimensions.expandViewport(this.viewport, this.selection) }

  private expandForRemoteSelections() { return this.dimensions.expandRemote(this.awareness, this.sheet.sheetId) }

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
      rowLabel: row => { const index = this.sheet.coordinates.canonicalRow(row); return index === undefined ? '' : String(index + 1) },
      getMergeRanges: () => this.sheet.getMergeRanges(), isCellLocked: (key, merge) => this.sheet.isCellLocked(key, merge),
      isCellPasswordLocked: (key, merge) => this.sheet.isCellPasswordLocked(key, merge), renderContent: this.renderContent,
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
      selection: this.selection, awareness: this.awareness, sheet: this.sheet, userColor: this.options.userColor, renderContent: this.renderContent,
      rowCount: this.rowCount, columnCount: this.columnCount,
      size: (axis: 'row' | 'column', index: number) => axis === 'row' ? this.getRowHeight(index) : this.getColumnWidth(index) }
  }

  destroy() {
    if (this.destroyed) return
    if (!this.session.external) this.editing.finish(true)
    this.destroyed = true
    this.imageUploads.clear()
    this.#watermark.destroy()
    this.rowViewDialog?.remove()
    this.viewportResizeObserver.disconnect()
    this.dialogs.close()
    this.editing.finish(false)
    this.archive.destroy()
    this.awareness.off('change', this.onAwarenessChange)
    this.cells.raw.unobserve(this.onCellsChange)
    this.doc.off('afterTransaction', this.onFormulaDependencies)
    this.styles.raw.unobserve(this.onStylesChange)
    this.rowHeights.raw.unobserve(this.onSizesChange)
    this.columnWidths.raw.unobserve(this.onSizesChange)
    this.merges.raw.unobserve(this.onMergesChange)
    this.locks.raw.unobserve(this.onLocksChange)
    this.sheet.coordinates.edits.row.unobserve(this.onAxesChange)
    this.sheet.coordinates.edits.column.unobserve(this.onAxesChange)
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
