import { createPasswordLock, verifyPasswordLock } from './passwordLock'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { WebrtcProvider } from 'y-webrtc'
import { WebsocketProvider } from 'y-websocket'
import './colwork-table.css'
import { colorWithAlpha } from './color'
import { cellKey, containsPosition, type CellPosition, type CellRange } from './range'
import { remoteSelectionRange, selectionFocusForMode, selectionRange, type AwarenessSelection, type SelectionMode } from './selection'
import { COLUMN_HEADER_HEIGHT, DEFAULT_COLUMN_WIDTH, DEFAULT_ROW_HEIGHT, HEADER_FONT_SIZE, MAX_ZOOM, MIN_COLUMN_WIDTH, MIN_ROW_HEIGHT, MIN_ZOOM, ROW_HEADER_WIDTH } from './tableConstants'
import { getViewportOffset, getViewportRange, getViewportTotalSize } from './viewport'
import { bytesToBase64, type YjsSnapshotFile, type YjsUpdateLogFile, type YjsUpdateRecord } from './yjsArchive'

export type ColworkTableOptions = {
  room: string
  signalingUrl?: string
  user: string
  rows?: string[][]
  rowCount?: number
  columnCount?: number
  onLog?: (message: string) => void
  userColor?: string
  peerOpts?: Record<string, unknown>
  transport?: 'webrtc' | 'websocket'
  websocketUrl?: string
  initializeAfterSync?: boolean
  readOnly?: boolean
  snapshot?: Uint8Array
  updates?: Uint8Array[]
}

type CellBorder = { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean }
type CellStyle = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; wrap?: boolean; border?: CellBorder; fontSize?: number; color?: string; background?: string; align?: 'left' | 'center' | 'right'; format?: 'general' | 'number' | 'date' | 'percent' }
type BooleanStyleKey = 'bold' | 'italic' | 'underline' | 'strike' | 'wrap'
type BorderMode = 'outer' | 'inner' | 'horizontal' | 'vertical'
type ClipboardPayload = { values: string[][]; styles: Array<Array<CellStyle | null>> }
const clipboardMime = 'application/x-colwork-cells'
const headers = ['任务', '负责人', '状态', '优先级', '开始日期', '备注']
const defaultIceServers = [
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]
const defaultRows = [
  ['设计协作表格', '小林', '进行中', '高', '2026-08-07', '欢迎测试'],
  ['整理组件 API', '阿南', '已完成', '中', '2026-08-08', '已补充示例'],
  ['补充单元测试', '小周', '未开始', '高', '2026-08-09', '覆盖边界输入'],
  ['实现虚拟滚动', '小林', '进行中', '高', '2026-08-10', '先支持行虚拟化'],
  ['接入 WebSocket', '阿南', '已完成', '中', '2026-08-11', '等待联调'],
  ['增加复制粘贴', '小周', '进行中', '中', '2026-08-12', '支持 TSV 格式'],
  ['检查 Safari 兼容性', '小雨', '阻塞', '高', '2026-08-13', '需要补充 ICE 日志'],
  ['编写使用文档', '阿南', '未开始', '低', '2026-08-14', '准备 API 清单'],
  ['优化移动端布局', '小雨', '未开始', '中', '2026-08-15', '检查横向滚动'],
  ['发布 v0.1.0', '小林', '未开始', '低', '2026-08-18', '等待最终验收'],
]

function columnLetter(index: number) {
  let value = index + 1
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

export class ColworkTable {
  private readonly doc: Y.Doc
  private readonly cells: Y.Map<string>
  private readonly styles: Y.Map<string>
  private readonly rowHeights: Y.Map<number>
  private readonly columnWidths: Y.Map<number>
  private readonly locks: Y.Map<string>
  private messageDialog?: HTMLDialogElement
  private passwordDialog?: HTMLDialogElement
  private destroyed = false
  private frozenRows = 0
  private frozenColumns = 0
  private readonly merges: Y.Map<string>
  private readonly undoManager: Y.UndoManager
  private readonly provider?: WebrtcProvider | WebsocketProvider
  private readonly awareness: Awareness
  private readonly root: HTMLElement
  private readonly options: ColworkTableOptions
  private readonly table: HTMLTableElement
  private readonly viewportResizeObserver: ResizeObserver
  private readonly viewport: HTMLDivElement
  private protectionMenuButton?: HTMLButtonElement
  private contextMenu?: HTMLDivElement
  private pendingCellContext?: { x: number; y: number }
  private rightButtonReleased = false
  private rightMouseUpPoint?: { x: number; y: number }
  private rightDrag?: { start: CellPosition; moved: boolean }
  private undoButton?: HTMLButtonElement
  private redoButton?: HTMLButtonElement
  private rowCountValue: number
  private columnCountValue: number
  private zoomRatio = 1
  private showGridLines = true
  private bandedRows = false
  private readonly readOnly: boolean
  private documentRevision = 0
  private updateSequence = 0
  private readonly updateLog: YjsUpdateRecord[] = []
  private resizing?: { axis: 'row' | 'column'; index: number; start: number; size: number; currentSize: number }
  private readonly onCellsChange = () => this.refreshValues()
  private readonly onStylesChange = () => this.refreshStyles()
  private readonly onSizesChange = () => this.render()
  private readonly onMergesChange = () => this.render()
  private readonly onLocksChange = () => {
    // Old history must not restore content underneath a newly received lock.
    this.undoManager.clear()
    if (this.editingKey && this.isCellLocked(this.editingKey)) this.finishEdit(false)
    if (this.resizing && this.isAxisLocked(this.resizing.axis, this.resizing.index)) {
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
    if (this.readOnly || this.editor) return
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
    if (event.key !== ' ' || !this.selectionFocus) return
    const key = `${this.selectionFocus.row}:${this.selectionFocus.column}`
    const cell = this.table.querySelector<HTMLTableCellElement>(`td[data-key="${key}"]`)
    if (!cell) return
    event.preventDefault()
    this.startEdit(cell, key)
  }
  private readonly onTableMouseDown = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('th')) event.preventDefault()
  }
  private readonly onDocumentMouseDown = (event: MouseEvent) => {
    if (this.contextMenu && !this.contextMenu.contains(event.target as Node) && !this.protectionMenuButton?.contains(event.target as Node)) this.hideContextMenu()
  }
  private readonly onWindowMouseUp = (event: MouseEvent) => {
    if (this.resizing) {
      if (this.resizing.axis === 'row') this.rowHeights.set(String(this.resizing.index), this.resizing.currentSize / this.zoomRatio)
      else this.columnWidths.set(String(this.resizing.index), this.resizing.currentSize / this.zoomRatio)
      this.resizing = undefined
      this.viewport.classList.remove('is-resizing')
      return
    }
    this.selecting = false
    this.headerSelecting = undefined
    if (event.button === 2) {
      this.rightButtonReleased = true
      this.rightMouseUpPoint = { x: event.clientX, y: event.clientY }
      if (this.pendingCellContext) {
        const point = this.rightMouseUpPoint
        this.pendingCellContext = undefined
        this.showCellContextMenu(point.x, point.y)
      }
    }
    if (!this.pendingAwarenessCursor) return
    this.sendAwareness(this.pendingAwarenessCursor)
  }
  private readonly onWindowBlur = () => {
    if (!this.headerSelecting) return
    this.selecting = false
    this.headerSelecting = undefined
    if (this.pendingAwarenessCursor) this.sendAwareness(this.pendingAwarenessCursor)
  }
  private readonly onWindowMouseMove = (event: MouseEvent) => {
    if (this.headerSelecting && !(event.buttons & 1)) this.onWindowBlur()
    if (!this.resizing) return
    const delta = this.resizing.axis === 'row' ? event.clientY - this.resizing.start : event.clientX - this.resizing.start
    const minimum = (this.resizing.axis === 'row' ? MIN_ROW_HEIGHT : MIN_COLUMN_WIDTH) * this.zoomRatio
    const size = Math.max(minimum, this.resizing.size + delta)
    this.resizing.currentSize = size
    this.render()
  }
  private readonly onHistoryChange = () => this.refreshHistoryButtons()
  private editor?: HTMLTextAreaElement
  private editingKey?: string
  private editingOriginal = ''
  private selectedKey?: string
  private selectionAnchor?: CellPosition
  private selectionFocus?: CellPosition
  private selectionMode?: SelectionMode
  private selecting = false
  private headerSelecting?: { axis: 'row' | 'column'; anchor: number }
  private pendingAwarenessCursor?: CellPosition & { offset?: number }
  private readonly loggedPeers = new Set<object>()
  private readonly loggedSignals = new Set<object>()
  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    this.documentRevision += 1
    const internal = this.provider as unknown as { room?: unknown } | undefined
    const record: YjsUpdateRecord = { seq: ++this.updateSequence, update: bytesToBase64(update), timestamp: Date.now() }
    this.updateLog.push(record)
    this.logChunk(`yjs:${origin === internal?.room ? 'recv' : 'send'}`, update)
    this.log(`yjs:state ${JSON.stringify({ cells: Array.from(this.cells.entries()), rowHeights: Array.from(this.rowHeights.entries()), columnWidths: Array.from(this.columnWidths.entries()), merges: Array.from(this.merges.entries()) })}`)
  }
  private readonly onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const internal = this.provider as unknown as { room?: unknown } | undefined
    this.log(`awareness:${origin === internal?.room ? 'recv' : 'send'} added=${added.join(',')} updated=${updated.join(',')} removed=${removed.join(',')}`)
    this.log(`awareness:state ${JSON.stringify(Array.from(this.awareness.getStates().entries()))}`)
  }

  constructor(root: HTMLElement, options: ColworkTableOptions) {
    this.root = root
    this.options = options
    this.readOnly = options.readOnly === true
    this.doc = new Y.Doc()
    this.cells = this.doc.getMap<string>('cells')
    this.styles = this.doc.getMap<string>('styles')
    this.rowHeights = this.doc.getMap<number>('rowHeights')
    this.columnWidths = this.doc.getMap<number>('columnWidths')
    this.merges = this.doc.getMap<string>('merges')
    this.locks = this.doc.getMap<string>('locks')
    this.rowCountValue = Math.max(options.rowCount ?? 100, options.rows?.length ?? defaultRows.length)
    this.columnCountValue = Math.max(options.columnCount ?? 10, headers.length)
    const useWebrtc = options.transport === 'webrtc'
    const socketURL = new URL(options.websocketUrl ?? 'ws://127.0.0.1:1234')
    const socketParams = Object.fromEntries(socketURL.searchParams)
    socketURL.search = ''
    if (this.readOnly) {
      this.awareness = new Awareness(this.doc)
    } else {
      this.provider = !useWebrtc
        ? new WebsocketProvider(socketURL.toString().replace(/\/$/, ''), encodeURIComponent(options.room), this.doc, { params: socketParams, connect: !options.initializeAfterSync })
        : new WebrtcProvider(options.room, this.doc, {
            signaling: [options.signalingUrl ?? 'ws://127.0.0.1:4444'],
            filterBcConns: false,
            peerOpts: options.peerOpts ?? {
              config: {
                iceServers: defaultIceServers,
              },
            },
          })
      this.awareness = this.provider.awareness
    }
    if (options.snapshot) Y.applyUpdate(this.doc, options.snapshot)
    options.updates?.forEach((update) => Y.applyUpdate(this.doc, update))
    this.log(`room:${options.room}`)
    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
    this.awareness.on('change', this.onAwarenessChange)
    this.awareness.setLocalStateField('user', { name: options.user, color: options.userColor })
    if (useWebrtc && this.provider) this.inspectConnections()

    const shell = document.createElement('section')
    shell.className = 'colwork-table'
    const toolbar = document.createElement('div')
    toolbar.className = 'colwork-table__toolbar'
    if (this.readOnly) toolbar.hidden = true
    toolbar.setAttribute('aria-label', '表格工具栏')
    const commandRow = document.createElement('div')
    commandRow.className = 'colwork-table__toolbar-row'
    const formatRow = document.createElement('div')
    formatRow.className = 'colwork-table__toolbar-row'
    toolbar.append(commandRow, formatRow)
    const group = (row: HTMLElement, label: string) => {
      const section = document.createElement('div')
      section.className = 'colwork-table__toolbar-group'
      section.setAttribute('role', 'group')
      section.setAttribute('aria-label', label)
      const caption = document.createElement('span')
      caption.className = 'colwork-table__group-label'
      caption.textContent = label
      section.append(caption)
      row.append(section)
      return section
    }
    const historyGroup = group(commandRow, '历史')
    const cellGroup = group(commandRow, '单元格')
    const protectionGroup = group(commandRow, '保护')
    const viewGroup = group(commandRow, '显示')
    const textGroup = group(formatRow, '文字')
    const alignmentGroup = group(formatRow, '对齐')
    const formatGroup = group(formatRow, '格式')
    const historyButtons: Array<[string, string, () => void]> = [
      ['撤销', '↶', () => this.undo()],
      ['重做', '↷', () => this.redo()],
    ]
    historyButtons.forEach(([title, label, action], index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `colwork-table__history colwork-table__history--${index === 0 ? 'undo' : 'redo'}`
      button.title = title
      button.textContent = label
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', action)
      if (index === 0) this.undoButton = button
      else this.redoButton = button
      historyGroup.append(button)
    })
    const gridActions: Array<[string, string, () => void]> = [
      ['合并单元格', '合并', () => this.mergeSelection()],
      ['拆分单元格', '拆分', () => this.unmergeSelection()],
    ]
    gridActions.forEach(([title, label, action]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'colwork-table__format colwork-table__grid-action'
      button.title = title
      button.textContent = label
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', action)
      cellGroup.append(button)
    })
    protectionGroup.querySelector('.colwork-table__group-label')?.remove()
    const protectionButton = document.createElement('button')
    this.protectionMenuButton = protectionButton
    protectionButton.type = 'button'
    protectionButton.className = 'colwork-table__format colwork-table__dropdown-trigger'
    protectionButton.textContent = '保护'
    protectionButton.title = '锁定、密码锁定与解锁'
    protectionButton.setAttribute('aria-label', '保护')
    protectionButton.setAttribute('aria-expanded', 'false')
    protectionButton.addEventListener('mousedown', event => event.preventDefault())
    protectionButton.addEventListener('click', () => {
      if (protectionButton.getAttribute('aria-expanded') === 'true') { this.hideContextMenu(); return }
      const rect = protectionButton.getBoundingClientRect()
      this.showContextMenu(rect.left, rect.bottom + 4, [{ label: '锁定与解锁', actions: this.protectionActions() }])
      protectionButton.setAttribute('aria-expanded', 'true')
    })
    protectionButton.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); protectionButton.click() }
    })
    protectionGroup.append(protectionButton)
    const viewControl = document.createElement('div')
    viewControl.className = 'colwork-table__view-control'
    const viewButton = document.createElement('button')
    viewButton.type = 'button'
    viewButton.className = 'colwork-table__format'
    viewButton.textContent = '视图'
    viewButton.setAttribute('aria-label', '视图')
    viewButton.classList.add('colwork-table__dropdown-trigger')
    viewButton.title = '本地视图选项'
    const viewMenu = document.createElement('div')
    viewMenu.className = 'colwork-table__view-menu'
    const viewOptions: Array<[string, () => boolean, (value: boolean) => void]> = [
      ['隔行异色', () => this.bandedRows, (value) => { this.bandedRows = value }],
      ['显示网格线', () => this.showGridLines, (value) => { this.showGridLines = value }],
    ]
    viewOptions.forEach(([label, getValue, setValue]) => {
      const option = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = getValue()
      checkbox.addEventListener('change', () => { setValue(checkbox.checked); this.render() })
      option.append(checkbox, document.createTextNode(label))
      viewMenu.append(option)
    })
    const freezeActions: Array<[string, () => void]> = [
      ['固定至选中行', () => this.freezeSelection('row')],
      ['固定至选中列', () => this.freezeSelection('column')],
      ['取消固定', () => this.setFrozenPanes(0, 0)],
    ]
    freezeActions.forEach(([label, action]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', action)
      viewMenu.append(button)
    })
    viewControl.append(viewButton, viewMenu)
    viewGroup.append(viewControl)
    ;[
      ['bold', 'B', '加粗'],
      ['italic', 'I', '斜体'],
      ['underline', 'U', '下划线'],
      ['strike', 'S', '删除线'],
      ['wrap', '换行', '自动换行'],
      ['align-left', '左', '左对齐'],
      ['align-center', '中', '居中'],
      ['align-right', '右', '右对齐'],
    ].forEach(([format, label, title]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `colwork-table__format colwork-table__format--${format}`
      button.textContent = label
      button.title = title
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => format.startsWith('align-') ? this.setStyle('align', format.slice(6) as CellStyle['align']) : this.toggleFormat(format as BooleanStyleKey))
      ;(format.startsWith('align-') || format === 'wrap' ? alignmentGroup : textGroup).append(button)
    })
    const fontSize = document.createElement('select')
    fontSize.className = 'colwork-table__select'
    fontSize.title = '字体大小'
    ;[10, 12, 14, 16, 18, 24].forEach((size) => {
      const option = document.createElement('option')
      option.value = String(size)
      option.textContent = `${size}px`
      fontSize.append(option)
    })
    fontSize.addEventListener('change', () => this.setStyle('fontSize', Number(fontSize.value)))
    textGroup.append(fontSize)
    const numberFormat = document.createElement('select')
    numberFormat.className = 'colwork-table__select'
    numberFormat.title = '单元格格式'
    ;[
      ['general', '常规'],
      ['number', '数字'],
      ['date', '日期'],
      ['percent', '百分比'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      numberFormat.append(option)
    })
    numberFormat.addEventListener('change', () => this.setStyle('format', numberFormat.value as CellStyle['format']))
    formatGroup.append(numberFormat)
    const clearFormat = document.createElement('button')
    clearFormat.type = 'button'
    clearFormat.className = 'colwork-table__format'
    clearFormat.title = '清除格式'
    clearFormat.textContent = '清除'
    clearFormat.addEventListener('mousedown', (event) => event.preventDefault())
    clearFormat.addEventListener('click', () => this.clearFormatting())
    formatGroup.append(clearFormat)
    const borderControl = document.createElement('div')
    borderControl.className = 'colwork-table__border-control'
    const borderButton = document.createElement('button')
    borderButton.type = 'button'
    borderButton.className = 'colwork-table__format'
    borderButton.title = '边框选项'
    borderButton.textContent = '边框'
    borderButton.setAttribute('aria-label', '边框')
    borderButton.classList.add('colwork-table__dropdown-trigger')
    const borderMenu = document.createElement('div')
    borderMenu.className = 'colwork-table__border-menu'
    ;[
      ['外围', 'outer'],
      ['中间', 'inner'],
      ['横线', 'horizontal'],
      ['竖线', 'vertical'],
    ].forEach(([label, mode]) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.textContent = label
      option.addEventListener('click', () => this.toggleBorder(mode as BorderMode))
      borderMenu.append(option)
    })
    borderControl.append(borderButton, borderMenu)
    formatGroup.insertBefore(borderControl, clearFormat)
    ;[
      ['color', '文字颜色'],
      ['background', '背景颜色'],
    ].forEach(([format, title]) => {
      const input = document.createElement('input')
      input.type = 'color'
      input.className = `colwork-table__color colwork-table__color--${format}`
      input.title = title
      input.addEventListener('input', () => this.setStyle(format as 'color' | 'background', input.value))
      ;(format === 'color' ? textGroup : formatGroup).append(input)
    })
    this.viewport = document.createElement('div')
    this.viewport.className = 'colwork-table__viewport'
    this.viewport.addEventListener('scroll', this.onViewportScroll)
    this.viewport.addEventListener('wheel', this.onViewportWheel, { passive: false })
    this.viewport.tabIndex = 0
    this.viewport.addEventListener('keydown', this.onViewportKeyDown)
    this.viewport.addEventListener('copy', this.onCopy, true)
    this.viewport.addEventListener('paste', this.onPaste, true)
    window.addEventListener('mouseup', this.onWindowMouseUp)
    window.addEventListener('mousemove', this.onWindowMouseMove)
    window.addEventListener('blur', this.onWindowBlur)
    document.addEventListener('mousedown', this.onDocumentMouseDown)
    this.table = document.createElement('table')
    this.table.addEventListener('mousedown', this.onTableMouseDown)
    this.viewport.append(this.table)
    shell.append(toolbar, this.viewport)
    root.replaceChildren(shell)

    const shouldSeed = !this.readOnly && !options.snapshot && !options.updates?.length
    const shouldSeedDemo = shouldSeed && this.cells.size === 0 && this.locks.size === 0
    if (shouldSeed && !options.initializeAfterSync) this.seed(options.rows ?? defaultRows)
    if (shouldSeedDemo && !options.initializeAfterSync) this.seedDemoFormatting()
    this.expandLogicalSizeFromDocument()
    this.undoManager = new Y.UndoManager([this.cells, this.styles, this.rowHeights, this.columnWidths, this.merges], { captureTimeout: 500 })
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
    this.viewportResizeObserver = new ResizeObserver(() => this.refreshFrozenBoundaries())
    this.viewportResizeObserver.observe(this.viewport)
    if (this.provider) {
      const providerEvents = this.provider as unknown as { on: (event: string, callback: (payload: any) => void) => void }
      providerEvents.on('status', ({ connected, status }) => {
        this.log(connected === true || status === 'connected' ? 'signaling:connected' : 'signaling:disconnected')
        if (useWebrtc) this.inspectConnections()
      })
      if (!useWebrtc) providerEvents.on('sync', (synced: boolean) => {
        this.log(synced ? 'synced' : 'syncing')
        if (!synced || !options.initializeAfterSync) return
        const metadata = this.doc.getMap<boolean>('colwork-metadata')
        if (!metadata.get('initialized')) {
          this.doc.transact(() => {
            if (shouldSeed && this.cells.size === 0 && this.locks.size === 0) {
              this.seed(options.rows ?? defaultRows)
              this.seedDemoFormatting()
            }
            metadata.set('initialized', true)
          })
          this.undoManager.clear()
        }
        this.expandLogicalSizeFromDocument()
        this.render()
      })
      else providerEvents.on('synced', ({ synced }) => this.log(synced ? 'synced' : 'syncing'))
      if (options.initializeAfterSync && this.provider instanceof WebsocketProvider) this.provider.connect()
      if (useWebrtc) {
        providerEvents.on('peers', ({ added, removed, webrtcPeers }) => {
          if (added.length) this.log(`peer:+${added.length}`)
          if (removed.length) this.log(`peer:-${removed.length}`)
          this.log(`webrtc:${webrtcPeers.length}`)
          this.inspectConnections()
        })
      }
    }
  }

  private log(message: string) {
    this.options.onLog?.(`${new Date().toLocaleTimeString()} ${message}`)
  }

  private undo() {
    if (this.readOnly || !this.undoManager.canUndo()) return
    if (this.editor) this.finishEdit(true)
    this.undoManager.undo()
  }

  private redo() {
    if (this.readOnly || !this.undoManager.canRedo()) return
    if (this.editor) this.finishEdit(true)
    this.undoManager.redo()
  }

  private refreshHistoryButtons() {
    if (this.undoButton) this.undoButton.disabled = this.readOnly || !this.undoManager.canUndo()
    if (this.redoButton) this.redoButton.disabled = this.readOnly || !this.undoManager.canRedo()
  }

  getYjsSnapshot(): YjsSnapshotFile {
    return {
      format: 'colwork.snapshot',
      version: 1,
      room: this.options.room,
      sequence: this.updateSequence,
      snapshot: bytesToBase64(Y.encodeStateAsUpdate(this.doc)),
      stateVector: bytesToBase64(Y.encodeStateVector(this.doc)),
    }
  }

  getYjsUpdateLog(): YjsUpdateLogFile {
    return {
      format: 'colwork.update-log',
      version: 1,
      room: this.options.room,
      updates: this.updateLog.map((record) => ({ ...record })),
    }
  }

  /** Freeze a leading prefix of rows/columns in this client only. */
  setFrozenPanes(rows: number, columns: number) {
    if (![rows, columns].every((value) => Number.isInteger(value) && value >= 0)) {
      throw new RangeError('Frozen row and column counts must be non-negative integers')
    }
    const nextRows = Math.min(rows, this.rowCount - 1)
    const nextColumns = Math.min(columns, this.columnCount - 1)
    if (this.hasPartialMerge('row', 0, nextRows - 1) || this.hasPartialMerge('column', 0, nextColumns - 1)) {
      this.showLockMessage('当前选择包含不完整的合并块，无法固定，请选择完整的合并块')
      return false
    }
    this.finishEdit(true)
    this.frozenRows = nextRows
    this.frozenColumns = nextColumns
    this.closeLockMessage()
    this.render()
    return true
  }

  private hasPartialMerge(axis: 'row' | 'column', start: number, end: number) {
    if (start > end) return false
    return this.getMergeRanges().some(merge => {
      const first = merge.start[axis]
      const last = merge.end[axis]
      return first <= end && last >= start && (first < start || last > end)
    })
  }

  private crossesFrozenBoundary(range: CellRange) {
    return (range.start.row < this.frozenRows && range.end.row >= this.frozenRows)
      || (range.start.column < this.frozenColumns && range.end.column >= this.frozenColumns)
  }

  private freezeSelection(axis: 'row' | 'column') {
    if (!this.selectionFocus) return
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    // Validate the selected collection as well as the resulting leading prefix.
    if (this.hasPartialMerge(axis, range.start[axis], range.end[axis])) {
      this.showLockMessage('当前选择包含不完整的合并块，无法固定，请选择完整的合并块')
      return
    }
    this.setFrozenPanes(axis === 'row' ? range.end.row + 1 : this.frozenRows,
      axis === 'column' ? range.end.column + 1 : this.frozenColumns)
  }

  private rangeHasLocks(range: CellRange) {
    return Array.from(this.locks.keys()).some((key) => {
      const [row, column] = key.split(':').map(Number)
      return containsPosition(range, { row, column })
    })
  }

  private isCellLocked(key: string) {
    if (this.locks.has(key)) return true
    const [row, column] = key.split(':').map(Number)
    const merge = this.getMergeRanges().find((range) => containsPosition(range, { row, column }))
    return !!merge && this.rangeHasLocks(merge)
  }

  private isCellPasswordLocked(key: string) {
    const protectedKey = (key: string) => this.locks.has(key) && this.locks.get(key) !== '1'
    if (protectedKey(key)) return true
    const [row, column] = key.split(':').map(Number)
    const merge = this.getMergeRanges().find(range => containsPosition(range, { row, column }))
    return !!merge && Array.from(this.locks.keys()).some(key => {
      const [row, column] = key.split(':').map(Number)
      return protectedKey(key) && containsPosition(merge, { row, column })
    })
  }

  private selectionHasLocks() {
    return this.rangeHasLocks(selectionRange(this.selectionAnchor, this.selectionFocus))
  }

  private isAxisLocked(axis: 'row' | 'column', index: number, following = false) {
    return Array.from(this.locks.keys()).some((key) => {
      const coordinate = Number(key.split(':')[axis === 'row' ? 0 : 1])
      return following ? coordinate >= index : coordinate === index
    })
  }

  /** Passwords are optional for legacy/plain locks; protected locks require verification. */
  async setSelectionLocked(locked: boolean, password?: string): Promise<void> {
    if (this.readOnly || this.destroyed || !this.selectionFocus) return
    this.finishEdit(true)
    const expanded = this.expandSelectionToMerges(
      this.selectionAnchor ?? this.selectionFocus, this.selectionFocus)
    const range = selectionRange(expanded.anchor, expanded.focus)
    const keys: string[] = []
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      for (let column = range.start.column; column <= range.end.column; column += 1) keys.push(cellKey({ row, column }))
    }
    const protectedRecords = [...new Set(keys.map(key => this.locks.get(key)).filter((value): value is string => value !== undefined && value !== '1'))]
    // Re-locking must never replace a password verifier with an unprotected lock.
    if (locked && protectedRecords.length) throw new Error('选区包含密码锁定单元格，请先用原密码解锁')
    const revision = this.documentRevision
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
    if (this.destroyed) return
    if (revision !== this.documentRevision) throw new Error('表格内容或锁定状态已变化，请重试')
    this.doc.transact(() => {
      keys.forEach(key => {
        if (locked) this.locks.set(key, record)
        else this.locks.delete(key)
      })
    })
  }

  private requestSelectionLock(locked: boolean, withPassword = false) {
    if (this.readOnly || this.destroyed || !this.selectionFocus || this.passwordDialog) return
    this.closeLockMessage()
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    const needsPassword = withPassword || (!locked && Array.from(this.locks.entries()).some(([key, value]) => {
      const [row, column] = key.split(':').map(Number)
      return value !== '1' && containsPosition(range, { row, column })
    }))
    if (!needsPassword) {
      void this.setSelectionLocked(locked).catch(error => this.showLockMessage(error instanceof Error ? error.message : '操作失败'))
      return
    }
    const dialog = document.createElement('dialog')
    this.passwordDialog = dialog
    dialog.className = 'colwork-table__password-dialog'
    dialog.setAttribute('aria-label', locked ? '密码锁定' : '密码解锁')
    const form = document.createElement('form')
    const title = document.createElement('h3')
    title.textContent = locked ? '设置锁定密码' : '输入解锁密码'
    const password = document.createElement('input')
    password.type = 'password'
    password.required = true
    password.placeholder = locked ? '设置密码' : '输入密码'
    password.autocomplete = locked ? 'new-password' : 'current-password'
    password.setAttribute('aria-label', '密码')
    const confirmation = document.createElement('input')
    confirmation.type = 'password'
    confirmation.required = locked
    confirmation.placeholder = '再次输入密码'
    confirmation.autocomplete = 'new-password'
    confirmation.setAttribute('aria-label', '确认密码')
    const error = document.createElement('p')
    error.setAttribute('role', 'alert')
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = locked ? '确认锁定' : '确认解锁'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => dialog.close())
    dialog.addEventListener('close', () => {
      password.value = ''; confirmation.value = ''
      dialog.remove()
      if (this.passwordDialog === dialog) this.passwordDialog = undefined
    })
    // Capture selection when opening; the modal keeps ordinary pointer/keyboard
    // actions out of the sheet. Cancellation is disabled while crypto is running.
    const anchor = this.selectionAnchor && { ...this.selectionAnchor }
    const focus = { ...this.selectionFocus }
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (submit.disabled) return
      if (locked && password.value !== confirmation.value) { error.textContent = '两次输入的密码不一致'; return }
      submit.disabled = true
      cancel.disabled = true
      dialog.oncancel = event => event.preventDefault()
      error.textContent = '正在处理…'
      try {
        this.selectionAnchor = anchor
        this.selectionFocus = focus
        await this.setSelectionLocked(locked, password.value)
        dialog.close()
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : '操作失败，请重试'
        password.value = ''; confirmation.value = ''
        password.focus()
      } finally {
        submit.disabled = false
        cancel.disabled = false
        dialog.oncancel = null
      }
    })
    form.append(title, password)
    if (locked) form.append(confirmation)
    form.append(error, submit, cancel)
    dialog.append(form)
    this.root.append(dialog)
    dialog.showModal()
    password.focus()
  }

  private closeLockMessage() {
    const dialog = this.messageDialog
    this.messageDialog = undefined
    dialog?.close()
    dialog?.remove()
  }

  private showLockMessage(message: string) {
    if (this.destroyed) return
    this.closeLockMessage()
    this.hideContextMenu()
    const dialog = document.createElement('dialog')
    this.messageDialog = dialog
    dialog.className = 'colwork-table__message-dialog'
    dialog.setAttribute('role', 'alertdialog')
    dialog.setAttribute('aria-label', '操作提示')
    dialog.setAttribute('aria-description', message)
    const title = document.createElement('h3')
    title.textContent = '操作提示'
    const status = document.createElement('p')
    status.className = 'colwork-table__lock-status'
    status.setAttribute('role', 'status')
    status.textContent = message
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.textContent = '确定'
    confirm.addEventListener('click', () => dialog.close())
    dialog.addEventListener('close', () => {
      dialog.remove()
      if (this.messageDialog === dialog) this.messageDialog = undefined
    })
    dialog.append(title, status, confirm)
    this.root.append(dialog)
    dialog.showModal()
    confirm.focus()
  }

  private get rowCount() { return this.rowCountValue }
  private get columnCount() { return this.columnCountValue }
  private get rowHeaderWidth() { return ROW_HEADER_WIDTH * this.zoomRatio }
  private get columnHeaderHeight() { return COLUMN_HEADER_HEIGHT * this.zoomRatio }

  private getRowHeight(row: number) {
    if (this.resizing?.axis === 'row' && this.resizing.index === row) return this.resizing.currentSize
    return (this.rowHeights.get(String(row)) ?? DEFAULT_ROW_HEIGHT) * this.zoomRatio
  }

  private getColumnWidth(column: number) {
    if (this.resizing?.axis === 'column' && this.resizing.index === column) return this.resizing.currentSize
    return (this.columnWidths.get(String(column)) ?? DEFAULT_COLUMN_WIDTH) * this.zoomRatio
  }

  private beginResize(axis: 'row' | 'column', index: number, event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (event.button !== 0 || this.readOnly || this.isAxisLocked(axis, index)) return
    this.finishEdit(true)
    this.selecting = false
    this.headerSelecting = undefined
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

  private selectRange(anchor: CellPosition, focus: CellPosition, mode?: 'row' | 'column' | 'all') {
    this.selectionAnchor = anchor
    this.selectionFocus = focus
    this.selectionMode = mode
    this.selectedKey = cellKey(anchor)
    this.pendingAwarenessCursor = focus
    this.refreshSelection()
  }

  private hideContextMenu() {
    this.protectionMenuButton?.setAttribute('aria-expanded', 'false')
    this.contextMenu?.remove()
    this.contextMenu = undefined
  }

  private showContextMenu(x: number, y: number, groups: Array<{ label: string; actions: Array<[string, () => void]> }>) {
    this.hideContextMenu()
    const menu = document.createElement('div')
    menu.className = 'colwork-table__context-menu'
    menu.setAttribute('aria-label', '表格操作')
    groups.forEach(({ label, actions }) => {
      const section = document.createElement('div')
      section.className = 'colwork-table__context-group'
      section.setAttribute('role', 'group')
      section.setAttribute('aria-label', label)
      const caption = document.createElement('div')
      caption.className = 'colwork-table__context-label'
      caption.textContent = label
      section.append(caption)
      actions.forEach(([label, action]) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        if (label.startsWith('删除') || label === '清空内容') button.className = 'is-destructive'
        button.addEventListener('click', () => {
          this.hideContextMenu()
          action()
        })
        section.append(button)
      })
      menu.append(section)
    })
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.hideContextMenu()
        this.viewport.focus({ preventScroll: true })
        return
      }
      const buttons = Array.from(menu.querySelectorAll('button'))
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      let next: number
      if (event.key === 'ArrowDown') next = (index + 1) % buttons.length
      else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = buttons.length - 1
      else return
      event.preventDefault()
      buttons[next]?.focus()
    })
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    document.body.append(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
    this.contextMenu = menu
    menu.querySelector('button')?.focus({ preventScroll: true })
  }

  private protectionActions(): Array<[string, () => void]> {
    return [
      ['锁定选区', () => this.requestSelectionLock(true)],
      ['密码锁定选区', () => this.requestSelectionLock(true, true)],
      ['解锁选区', () => this.requestSelectionLock(false)],
    ]
  }

  private hasHeaderSelection(axis: 'row' | 'column', index: number) {
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    return this.selectionMode === axis && (axis === 'row'
      ? index >= range.start.row && index <= range.end.row
      : index >= range.start.column && index <= range.end.column)
  }

  private openRowContextMenu(event: MouseEvent, row: number) {
    if (this.readOnly) return
    event.preventDefault()
    event.stopPropagation()
    if (!this.hasHeaderSelection('row', row)) this.selectHeaderRange('row', row, false)
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    const count = range.end.row - range.start.row + 1
    this.showContextMenu(event.clientX, event.clientY, [
      { label: '行操作', actions: [
        [`在上方插入 ${count} 行`, () => this.modifyAxis('row', range.start.row, count)],
        [`在下方插入 ${count} 行`, () => this.modifyAxis('row', range.end.row + 1, count)],
        [`删除 ${count} 行`, () => this.deleteRows()],
      ] },
      { label: '固定', actions: [
        ['固定至此行', () => this.freezeSelection('row')],
        ['取消固定', () => this.setFrozenPanes(0, 0)],
      ] },
      { label: '保护', actions: this.protectionActions() },
    ])
  }

  private openColumnContextMenu(event: MouseEvent, column: number) {
    if (this.readOnly) return
    event.preventDefault()
    event.stopPropagation()
    if (!this.hasHeaderSelection('column', column)) this.selectHeaderRange('column', column, false)
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    const count = range.end.column - range.start.column + 1
    this.showContextMenu(event.clientX, event.clientY, [
      { label: '列操作', actions: [
        [`在左侧插入 ${count} 列`, () => this.modifyAxis('column', range.start.column, count)],
        [`在右侧插入 ${count} 列`, () => this.modifyAxis('column', range.end.column + 1, count)],
        [`删除 ${count} 列`, () => this.deleteColumns()],
      ] },
      { label: '固定', actions: [
        ['固定至此列', () => this.freezeSelection('column')],
        ['取消固定', () => this.setFrozenPanes(0, 0)],
      ] },
      { label: '保护', actions: this.protectionActions() },
    ])
  }

  private mergeKey(range: CellRange) {
    return `${range.start.row}:${range.start.column}-${range.end.row}:${range.end.column}`
  }

  private parseMergeKey(key: string): CellRange | undefined {
    const match = key.match(/^(\d+):(\d+)-(\d+):(\d+)$/)
    if (!match) return undefined
    return {
      start: { row: Number(match[1]), column: Number(match[2]) },
      end: { row: Number(match[3]), column: Number(match[4]) },
    }
  }

  private getMergeRanges() {
    return Array.from(this.merges.keys()).flatMap((key) => {
      const range = this.parseMergeKey(key)
      return range ? [range] : []
    })
  }

  private expandSelectionToMerges(anchor: CellPosition, focus: CellPosition) {
    let range = selectionRange(anchor, focus)
    for (const merge of this.getMergeRanges()) {
      const intersects = merge.start.row <= range.end.row && merge.end.row >= range.start.row
        && merge.start.column <= range.end.column && merge.end.column >= range.start.column
      if (!intersects) continue
      range = {
        start: { row: Math.min(range.start.row, merge.start.row), column: Math.min(range.start.column, merge.start.column) },
        end: { row: Math.max(range.end.row, merge.end.row), column: Math.max(range.end.column, merge.end.column) },
      }
    }
    const forwardRow = focus.row >= anchor.row
    const forwardColumn = focus.column >= anchor.column
    return {
      anchor: {
        row: forwardRow ? range.start.row : range.end.row,
        column: forwardColumn ? range.start.column : range.end.column,
      },
      focus: {
        row: forwardRow ? range.end.row : range.start.row,
        column: forwardColumn ? range.end.column : range.start.column,
      },
    }
  }

  private getMergeStartingAt(row: number, column: number) {
    return this.getMergeRanges().find((range) => range.start.row === row && range.start.column === column)
  }

  private isMergeCovered(row: number, column: number) {
    return this.getMergeRanges().some((range) => containsPosition(range, { row, column }) && (range.start.row !== row || range.start.column !== column))
  }

  private mergeSelection() {
    if (this.readOnly || this.selectionHasLocks()) return
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    if (range.start.row === range.end.row && range.start.column === range.end.column) return
    if (this.crossesFrozenBoundary(range)) {
      this.showLockMessage('合并范围同时包含固定和非固定区域，无法合并，请调整选区或取消固定')
      return
    }
    this.closeLockMessage()
    this.doc.transact(() => {
      this.getMergeRanges().forEach((existing) => {
        if (containsPosition(range, existing.start) || containsPosition(existing, range.start)) this.merges.delete(this.mergeKey(existing))
      })
      this.merges.set(this.mergeKey(range), '1')
    })
  }

  private unmergeSelection() {
    if (this.readOnly || this.selectionHasLocks()) return
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    this.doc.transact(() => this.getMergeRanges().forEach((existing) => {
      if (containsPosition(range, existing.start) || containsPosition(existing, range.start)) this.merges.delete(this.mergeKey(existing))
    }))
  }

  private modifyAxis(axis: 'row' | 'column', index: number, amount: number, removeCount = 0) {
    if (this.readOnly || amount === 0 || this.isAxisLocked(axis, index, true)) return
    const maps = [this.cells, this.styles]
    this.doc.transact(() => {
      maps.forEach((map) => {
        const entries = Array.from(map.entries())
        map.clear()
        entries.forEach(([key, value]) => {
          const [row, column] = key.split(':').map(Number)
          const coordinate = axis === 'row' ? row : column
          if (removeCount && coordinate >= index && coordinate < index + removeCount) return
          const nextCoordinate = coordinate >= index + removeCount ? coordinate + amount : coordinate
          const nextKey = axis === 'row' ? cellKey({ row: nextCoordinate, column }) : cellKey({ row, column: nextCoordinate })
          map.set(nextKey, value)
        })
      })
      const merges = this.getMergeRanges()
      this.merges.clear()
      merges.forEach((range) => {
        const start = axis === 'row' ? range.start.row : range.start.column
        const end = axis === 'row' ? range.end.row : range.end.column
        if (removeCount && start < index + removeCount && end >= index) return
        const shift = start >= index + removeCount ? amount : 0
        const next = axis === 'row'
          ? { start: { row: range.start.row + shift, column: range.start.column }, end: { row: range.end.row + shift, column: range.end.column } }
          : { start: { row: range.start.row, column: range.start.column + shift }, end: { row: range.end.row, column: range.end.column + shift } }
        this.merges.set(this.mergeKey(next), '1')
      })
    })
    if (axis === 'row') this.rowCountValue = Math.max(1, this.rowCountValue + amount)
    else this.columnCountValue = Math.max(1, this.columnCountValue + amount)
    this.render()
  }

  private deleteRows() {
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    const count = Math.min(range.end.row - range.start.row + 1, this.rowCount - 1)
    this.modifyAxis('row', range.start.row, -count, count)
  }

  private deleteColumns() {
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    const count = Math.min(range.end.column - range.start.column + 1, this.columnCount - 1)
    this.modifyAxis('column', range.start.column, -count, count)
  }

  private selectHeaderRange(axis: 'row' | 'column', index: number, extend: boolean) {
    let anchor = index
    if (extend && this.selectionMode === axis) {
      anchor = axis === 'row' ? this.selectionAnchor?.row ?? index : this.selectionAnchor?.column ?? index
    }
    this.selectHeaderSpan(axis, anchor, index)
  }

  private selectHeaderSpan(axis: 'row' | 'column', anchor: number, index: number) {
    if (axis === 'row') {
      this.selectRange({ row: anchor, column: 0 }, { row: index, column: this.columnCount - 1 }, 'row')
    } else {
      this.selectRange({ row: 0, column: anchor }, { row: this.rowCount - 1, column: index }, 'column')
    }
  }

  private addHeaderSelection(element: HTMLElement, axis: 'row' | 'column', index: number) {
    element.dataset.selectionAxis = axis
    element.dataset.selectionIndex = String(index)
    element.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      this.finishEdit(true)
      this.viewport.focus({ preventScroll: true })
      this.hideContextMenu()
      this.selectHeaderRange(axis, index, event.shiftKey)
      this.headerSelecting = { axis, anchor: this.selectionAnchor![axis] }
      this.selecting = true
    })
    element.addEventListener('mouseenter', (event) => {
      if (!this.selecting || !this.headerSelecting || this.headerSelecting.axis !== axis) return
      if (!(event.buttons & 1)) { this.onWindowBlur(); return }
      this.selectHeaderSpan(axis, this.headerSelecting.anchor, index)
    })
    element.addEventListener('contextmenu', (event) => axis === 'row' ? this.openRowContextMenu(event, index) : this.openColumnContextMenu(event, index))
  }

  private expandLogicalSpace() {
    const nearBottom = this.viewport.scrollTop + this.viewport.clientHeight >= this.viewport.scrollHeight - 280
    const nearRight = this.viewport.scrollLeft + this.viewport.clientWidth >= this.viewport.scrollWidth - 280
    const rowExpanded = nearBottom
    const columnExpanded = nearRight
    if (nearBottom) this.rowCountValue += 100
    if (nearRight) this.columnCountValue += 5
    if (this.selectionMode && (rowExpanded || columnExpanded)) {
      const focus = this.selectionFocus ?? { row: 0, column: 0 }
      this.selectionFocus = selectionFocusForMode(this.selectionMode, focus, this.rowCount, this.columnCount)
      this.publishSelection()
    }
  }

  private publishSelection() {
    this.updateAwareness()
  }

  private updateAwareness(fields: Record<string, unknown> = {}) {
    const state = this.awareness.getLocalState() ?? {}
    this.awareness.setLocalState({
      ...state,
      ...fields,
      selection: { anchor: this.selectionAnchor, focus: this.selectionFocus, mode: this.selectionMode },
    })
  }

  private expandForRemoteSelections() {
    let nextRowCount = this.rowCount
    let nextColumnCount = this.columnCount
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID) return
      const selection = state.selection as AwarenessSelection | undefined
      if (!selection?.anchor || !selection.focus) return
      nextRowCount = Math.max(nextRowCount, selection.anchor.row + 1, selection.focus.row + 1)
      nextColumnCount = Math.max(nextColumnCount, selection.anchor.column + 1, selection.focus.column + 1)
    })
    const changed = nextRowCount !== this.rowCount || nextColumnCount !== this.columnCount
    this.rowCountValue = nextRowCount
    this.columnCountValue = nextColumnCount
    return changed
  }

  private getSelectionBounds() {
    const anchor = this.selectionAnchor ?? this.selectionFocus ?? { row: 0, column: 0 }
    const focus = this.selectionFocus ?? anchor
    const range = selectionRange(anchor, focus)
    return { top: range.start.row, bottom: range.end.row, left: range.start.column, right: range.end.column }
  }

  private selectCell(row: number, column: number, extend = false) {
    const position = { row, column }
    this.selectionMode = undefined
    if (!extend || !this.selectionAnchor) this.selectionAnchor = position
    const expanded = this.expandSelectionToMerges(this.selectionAnchor, position)
    this.selectionAnchor = expanded.anchor
    this.selectionFocus = expanded.focus
    this.selectedKey = `${row}:${column}`
    this.pendingAwarenessCursor = position
  }

  private isPositionSelected(position: CellPosition) {
    return containsPosition(selectionRange(this.selectionAnchor, this.selectionFocus), position)
  }

  private selectionToClipboard(): ClipboardPayload | undefined {
    if (!this.selectionFocus) return undefined
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    const values: string[][] = []
    const styles: Array<Array<CellStyle | null>> = []
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      const valueRow: string[] = []
      const styleRow: Array<CellStyle | null> = []
      for (let column = range.start.column; column <= range.end.column; column += 1) {
        const key = cellKey({ row, column })
        valueRow.push(this.cells.get(key) ?? '')
        const style = this.readStyle(key)
        styleRow.push(Object.keys(style).length ? style : null)
      }
      values.push(valueRow)
      styles.push(styleRow)
    }
    return { values, styles }
  }

  private selectionToText() {
    return this.selectionToClipboard()?.values.map((row) => row.join('\t')).join('\n') ?? ''
  }

  private copySelection() {
    const text = this.selectionToText()
    if (text) void navigator.clipboard?.writeText(text)
  }

  private clearSelectionContents() {
    if (this.readOnly || this.selectionHasLocks()) return
    const range = selectionRange(this.selectionAnchor, this.selectionFocus)
    this.doc.transact(() => {
      for (let row = range.start.row; row <= range.end.row; row += 1) {
        for (let column = range.start.column; column <= range.end.column; column += 1) this.cells.delete(cellKey({ row, column }))
      }
    })
  }

  private showCellContextMenu(x: number, y: number) {
    if (this.readOnly) return
    this.showContextMenu(x, y, [
      { label: '编辑', actions: [
        ['复制', () => this.copySelection()],
        ['清空内容', () => this.clearSelectionContents()],
      ] },
      { label: '单元格', actions: [
        ['合并单元格', () => this.mergeSelection()],
        ['取消合并单元格', () => this.unmergeSelection()],
      ] },
      { label: '固定', actions: [
        ['固定至选中行', () => this.freezeSelection('row')],
        ['固定至选中列', () => this.freezeSelection('column')],
        ['取消固定', () => this.setFrozenPanes(0, 0)],
      ] },
      { label: '保护', actions: this.protectionActions() },
    ])
  }

  private openCellContextMenu(event: MouseEvent) {
    if (this.readOnly) return
    event.preventDefault()
    event.stopPropagation()
    this.pendingCellContext = { x: event.clientX, y: event.clientY }
    if (this.rightButtonReleased) {
      this.pendingCellContext = undefined
      const point = this.rightMouseUpPoint ?? { x: event.clientX, y: event.clientY }
      this.showCellContextMenu(point.x, point.y)
    }
  }

  private sendAwareness(cursor: CellPosition & { offset?: number }) {
    this.pendingAwarenessCursor = undefined
    this.updateAwareness({ cursor, editing: this.editingKey ?? null })
  }

  private onCopy = (event: ClipboardEvent) => {
    const payload = this.selectionToClipboard()
    if (!payload || !event.clipboardData) return
    const text = payload.values.map((row) => row.join('\t')).join('\n')
    event.clipboardData.setData('text/plain', text)
    event.clipboardData.setData(clipboardMime, JSON.stringify(payload))
    event.preventDefault()
  }

  private onPaste = (event: ClipboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (this.readOnly) return
    const text = event.clipboardData?.getData('text/plain')?.replace(/^\uFEFF/, '')
    if (!text || !this.selectionFocus) return
    if (this.editor) this.finishEdit(false)
    let rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((row, index, all) => !(index === all.length - 1 && row === '')).map((row) => row.split('\t'))
    let pastedStyles: Array<Array<CellStyle | null>> | undefined
    const structured = event.clipboardData?.getData(clipboardMime)
    if (structured) {
      try {
        const payload = JSON.parse(structured) as ClipboardPayload
        if (Array.isArray(payload.values) && Array.isArray(payload.styles)) {
          rows = payload.values
          pastedStyles = payload.styles
        }
      } catch {
        pastedStyles = undefined
      }
    }
    const start = this.selectionFocus
    const columnCount = Math.max(...rows.map((row) => row.length))
    if (rows.some((row, r) => row.some((_, c) => this.isCellLocked(cellKey({ row: start.row + r, column: start.column + c }))))) return
    this.doc.transact(() => rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      const targetRow = start.row + rowIndex
      const targetColumn = start.column + columnIndex
      if (targetRow >= this.rowCount || targetColumn >= this.columnCount) return
      const key = cellKey({ row: targetRow, column: targetColumn })
      this.cells.set(key, value)
      if (pastedStyles) {
        const style = pastedStyles[rowIndex]?.[columnIndex]
        if (style) this.styles.set(key, JSON.stringify(style))
        else this.styles.delete(key)
      }
    })))
    this.selectionAnchor = start
    this.selectionFocus = { row: Math.min(this.rowCount - 1, start.row + rows.length - 1), column: Math.min(this.columnCount - 1, start.column + columnCount - 1) }
    this.render()
  }

  private logChunk(label: string, data: Uint8Array) {
    const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join(' ')
    this.log(`${label} bytes=${data.byteLength} hex=${hex}`)
  }

  private inspectConnections() {
    const internal = this.provider as unknown as {
      signalingConns?: Array<{ send: (message: unknown) => void; on: (event: string, callback: (message: unknown) => void) => void }>
      room?: { webrtcConns: Map<string, { peer: { send: (data: Uint8Array) => void; on: (event: string, callback: (data: Uint8Array) => void) => void } }> }
    }
    internal.signalingConns?.forEach((connection) => {
      if (this.loggedSignals.has(connection)) return
      this.loggedSignals.add(connection)
      const send = connection.send.bind(connection)
      connection.send = (message) => {
        this.log(`signal:send ${JSON.stringify(message)}`)
        send(message)
      }
      connection.on('message', (message) => this.log(`signal:recv ${JSON.stringify(message)}`))
      connection.on('connect', () => this.log('signal:connect'))
      connection.on('disconnect', () => this.log('signal:disconnect'))
      connection.on('error', (error) => this.log(`signal:error ${String(error)}`))
    })
    internal.room?.webrtcConns.forEach((connection, peerId) => {
      const peer = connection.peer
      if (this.loggedPeers.has(peer)) return
      this.loggedPeers.add(peer)
      const send = peer.send.bind(peer)
      peer.send = (data) => {
        this.logChunk(`webrtc:send peer=${peerId}`, data)
        send(data)
      }
      peer.on('data', (data) => this.logChunk(`webrtc:recv peer=${peerId}`, data))
      peer.on('connect', () => this.log(`webrtc:connect peer=${peerId}`))
      peer.on('close', () => this.log(`webrtc:close peer=${peerId}`))
      peer.on('error', (error) => this.log(`webrtc:error peer=${peerId} ${String(error)}`))
    })
  }

  private seed(rows: string[][]) {
    rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      const key = `${rowIndex}:${columnIndex}`
      if (!this.cells.has(key) && !this.isCellLocked(key)) this.cells.set(key, value)
    }))
  }

  private seedDemoFormatting() {
    this.doc.transact(() => {
      this.cells.set('0:0', '设计协作表格\n多人协作工作区')
      this.cells.delete('0:1')
      this.cells.delete('0:2')
      this.merges.set('0:0-0:2', '1')
      this.styles.set('0:0', JSON.stringify({ bold: true, fontSize: 16, color: '#0f172a', background: '#bae6fd', align: 'center', wrap: true, border: { top: true, right: true, bottom: true, left: true } }))
      this.styles.set('1:0', JSON.stringify({ bold: true, underline: true, background: '#fef3c7', border: { bottom: true } }))
      this.styles.set('1:1', JSON.stringify({ italic: true, color: '#7c3aed' }))
      this.styles.set('1:2', JSON.stringify({ strike: true, color: '#b91c1c' }))
      this.cells.set('2:0', '125000')
      this.styles.set('2:0', JSON.stringify({ format: 'number', fontSize: 14, border: { top: true, bottom: true } }))
      this.cells.set('2:1', '0.72')
      this.styles.set('2:1', JSON.stringify({ format: 'percent', color: '#047857', align: 'right' }))
      this.cells.set('2:2', '2026-08-09')
      this.styles.set('2:2', JSON.stringify({ format: 'date', background: '#dcfce7' }))
      this.cells.set('3:0', '这是一段较长的演示内容\n可使用自动换行工具查看')
      this.styles.set('3:0', JSON.stringify({ wrap: true, background: '#f1f5f9', border: { top: true, right: true, bottom: true, left: true } }))
      this.cells.set('4:0', '删除线示例')
      this.styles.set('4:0', JSON.stringify({ strike: true, color: '#64748b' }))
      this.cells.set('5:0', '合并区域示例')
      this.cells.delete('5:1')
      this.cells.delete('5:2')
      this.merges.set('5:0-5:2', '1')
      this.styles.set('5:0', JSON.stringify({ bold: true, align: 'center', background: '#ede9fe', border: { top: true, right: true, bottom: true, left: true } }))
      this.rowHeights.set('0', 72)
      this.rowHeights.set('3', 72)
      this.rowHeights.set('5', 44)
      this.columnWidths.set('0', 220)
      this.columnWidths.set('1', 130)
      this.columnWidths.set('2', 130)
    })
  }

  private expandLogicalSizeFromDocument() {
    const keys = [...this.cells.keys(), ...this.styles.keys(), ...this.locks.keys(), ...this.rowHeights.keys(), ...this.columnWidths.keys()]
      .map((key) => key.split(':').map(Number))
      .filter(([row, column]) => Number.isInteger(row) && Number.isInteger(column))
    if (!keys.length) return
    this.rowCountValue = Math.max(this.rowCount, ...keys.map(([row]) => row + 1))
    this.columnCountValue = Math.max(this.columnCount, ...keys.map(([, column]) => column + 1))
  }

  private render() {
    if (this.editor) this.finishEdit(true)
    const columnCount = this.columnCount
    const rowCount = this.rowCount
    this.frozenRows = Math.min(this.frozenRows, rowCount - 1)
    this.frozenColumns = Math.min(this.frozenColumns, columnCount - 1)
    // A remote merge cannot be rejected locally; release only affected local panes.
    const invalidRows = this.hasPartialMerge('row', 0, this.frozenRows - 1)
    const invalidColumns = this.hasPartialMerge('column', 0, this.frozenColumns - 1)
    if (invalidRows || invalidColumns) {
      if (invalidRows) this.frozenRows = 0
      if (invalidColumns) this.frozenColumns = 0
      this.showLockMessage('合并区域已变化，已取消与合并块冲突的固定行列')
    }
    const rowSize = (row: number) => this.getRowHeight(row)
    const columnSize = (column: number) => this.getColumnWidth(column)
    const view = getViewportRange({
      scrollTop: this.viewport.scrollTop,
      scrollLeft: this.viewport.scrollLeft,
      clientHeight: this.viewport.clientHeight || 560,
      clientWidth: this.viewport.clientWidth || 900,
      rowCount,
      columnCount,
      rowSize,
      columnSize,
      overscan: 4,
    })
    // Keep complete visible merges mounted without changing the frozen boundary.
    let changed = true
    const merges = this.getMergeRanges()
    while (changed) {
      changed = false
      for (const merge of merges) {
        const visibleRow = merge.start.row <= view.bottom && (merge.end.row >= view.top || merge.start.row < this.frozenRows)
        const visibleColumn = merge.start.column <= view.right && (merge.end.column >= view.left || merge.start.column < this.frozenColumns)
        if (!visibleRow || !visibleColumn) continue
        if (merge.start.row >= this.frozenRows && merge.start.row < view.top) { view.top = merge.start.row; changed = true }
        if (merge.start.column >= this.frozenColumns && merge.start.column < view.left) { view.left = merge.start.column; changed = true }
        if (merge.end.row > view.bottom) { view.bottom = merge.end.row; changed = true }
        if (merge.end.column > view.right) { view.right = merge.end.column; changed = true }
      }
    }
    view.bottom = Math.max(view.bottom, this.frozenRows - 1)
    view.right = Math.max(view.right, this.frozenColumns - 1)
    const rowStart = Math.max(this.frozenRows, view.top)
    const columnStart = Math.max(this.frozenColumns, view.left)
    const indices = (fixed: number, start: number, end: number) => [
      ...Array.from({ length: fixed }, (_, index) => index),
      -1, // spacer between the frozen prefix and the virtual window
      ...Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index),
    ]
    const rows = indices(this.frozenRows, rowStart, view.bottom)
    const columns = indices(this.frozenColumns, columnStart, view.right)
    const gapWidth = getViewportOffset(columnStart, columnSize) - getViewportOffset(this.frozenColumns, columnSize)
    const gapHeight = getViewportOffset(rowStart, rowSize) - getViewportOffset(this.frozenRows, rowSize)
    const pin = (element: HTMLElement, row: number, column: number) => {
      const top = row >= 0 && row < this.frozenRows
      const left = column >= 0 && column < this.frozenColumns
      if (!top && !left) return
      element.classList.add('is-frozen')
      element.style.position = 'sticky'
      if (top) element.style.top = `${this.columnHeaderHeight + getViewportOffset(row, rowSize)}px`
      if (left) element.style.left = `${this.rowHeaderWidth + getViewportOffset(column, columnSize)}px`
      element.style.zIndex = String(row < 0 ? 10 : column < 0 ? 8 : top && left ? 5 : top ? 4 : 3)
    }
    const thead = document.createElement('thead')
    const headerRow = document.createElement('tr')
    const corner = document.createElement('th')
    corner.style.width = `${this.rowHeaderWidth}px`
    corner.style.height = `${this.columnHeaderHeight}px`
    corner.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.selectRange({ row: 0, column: 0 }, { row: rowCount - 1, column: columnCount - 1 }, 'all')
    })
    headerRow.append(corner)
    const columnSpacer = (width: number) => {
      const th = document.createElement('th')
      th.style.width = `${width}px`
      th.style.padding = '0'
      th.style.border = '0'
      return th
    }
    for (const index of columns) {
      if (index === -1) { headerRow.append(columnSpacer(gapWidth)); continue }
      const th = document.createElement('th')
      th.style.width = `${columnSize(index)}px`
      th.style.height = `${this.columnHeaderHeight}px`
      th.style.fontSize = `${HEADER_FONT_SIZE * this.zoomRatio}px`
      const letter = document.createElement('b')
      letter.className = 'colwork-table__column-letter'
      letter.textContent = columnLetter(index)
      th.append(letter)
      this.addResizeHandle(th, 'column', index)
      this.addHeaderSelection(th, 'column', index)
      pin(th, -1, index)
      headerRow.append(th)
    }
    headerRow.append(columnSpacer(getViewportTotalSize(columnCount, columnSize) - getViewportOffset(view.right + 1, columnSize)))
    thead.append(headerRow)
    const tbody = document.createElement('tbody')
    const spacer = (height: number) => {
      const tr = document.createElement('tr')
      tr.className = 'colwork-table__spacer'
      tr.style.height = `${height}px`
      const td = document.createElement('td')
      td.colSpan = columns.length + 2
      td.style.height = `${height}px`
      tr.append(td)
      return tr
    }
    for (const row of rows) {
      if (row === -1) { tbody.append(spacer(gapHeight)); continue }
      const tr = document.createElement('tr')
      if (this.bandedRows && row % 2 === 1) tr.className = 'is-banded-row'
      tr.style.height = `${rowSize(row)}px`
      const number = document.createElement('th'); number.style.width = `${this.rowHeaderWidth}px`; number.style.height = `${rowSize(row)}px`; number.style.fontSize = `${HEADER_FONT_SIZE * this.zoomRatio}px`; number.textContent = String(row + 1); this.addResizeHandle(number, 'row', row); this.addHeaderSelection(number, 'row', row); tr.append(number)
      pin(number, row, -1)
      for (const column of columns) {
        if (column === -1) {
          const leading = document.createElement('td')
          leading.style.width = `${gapWidth}px`
          leading.style.padding = '0'
          leading.style.border = '0'
          tr.append(leading)
          continue
        }
        if (this.isMergeCovered(row, column)) continue
        const key = cellKey({ row, column })
        const td = document.createElement('td')
        td.style.width = `${columnSize(column)}px`
        td.style.height = `${rowSize(row)}px`
        td.dataset.key = key
        const merge = this.getMergeStartingAt(row, column)
        if (merge) {
          td.rowSpan = merge.end.row - merge.start.row + 1
          td.colSpan = merge.end.column - merge.start.column + 1
        }
        const value = document.createElement('span')
        value.className = 'colwork-table__cell-value'
        value.style.height = `${Math.max(0, rowSize(row) - 4)}px`
        value.style.maxHeight = `${Math.max(0, rowSize(row) - 4)}px`
        value.textContent = this.displayValue(key)
        this.applyStyle(value, key)
        td.append(value)
        this.applyStyle(td, key)
        pin(td, row, column)
        const locked = this.isCellLocked(key)
        td.classList.toggle('is-locked', locked)
        td.classList.toggle('is-password-locked', this.isCellPasswordLocked(key))
        td.setAttribute('aria-readonly', String(this.readOnly || locked))
        if (locked) td.title = this.isCellPasswordLocked(key) ? '密码锁定：验证密码后可编辑' : '已锁定：解锁后可编辑'
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
          this.viewport.focus({ preventScroll: true })
          this.selecting = true
          if (event.button === 0 || !this.isPositionSelected({ row, column })) this.selectCell(row, column, event.shiftKey)
          this.refreshSelection()
        })
        td.addEventListener('mouseenter', () => {
          if (!this.selecting || this.headerSelecting) return
          if (this.rightDrag) {
            if (this.rightDrag.start.row === row && this.rightDrag.start.column === column) return
            if (!this.rightDrag.moved) {
              this.rightDrag.moved = true
              this.selectionMode = undefined
              this.selectionAnchor = this.rightDrag.start
              this.selectedKey = cellKey(this.rightDrag.start)
            }
          }
          this.selectCell(row, column, true)
          this.refreshSelection()
        })
        if (!this.readOnly) td.addEventListener('dblclick', () => this.startEdit(td, key, false))
        td.addEventListener('contextmenu', (event) => this.openCellContextMenu(event))
        tr.append(td)
      }
      const trailing = document.createElement('td')
      trailing.style.width = `${getViewportTotalSize(columnCount, columnSize) - getViewportOffset(view.right + 1, columnSize)}px`
      trailing.style.padding = '0'
      trailing.style.border = '0'
      tr.append(trailing)
      tbody.append(tr)
    }
    tbody.append(spacer(getViewportTotalSize(rowCount, rowSize) - getViewportOffset(view.bottom + 1, rowSize)))
    this.table.style.setProperty('--colwork-zoom', String(this.zoomRatio))
    this.table.style.width = `${this.rowHeaderWidth + getViewportTotalSize(columnCount, columnSize)}px`
    this.table.classList.toggle('is-grid-hidden', !this.showGridLines)
    this.table.classList.toggle('is-banded-rows', this.bandedRows)
    this.table.style.fontSize = `${this.zoomRatio}em`
    this.table.replaceChildren(thead, tbody)
    this.refreshFrozenBoundaries()
    this.refreshSelection()
    this.refreshCursors()
  }

  private refreshFrozenBoundaries() {
    this.viewport.querySelectorAll('.colwork-table__frozen-boundary').forEach(line => line.remove())
    const add = (axis: 'row' | 'column', count: number, position: number, limit: number) => {
      if (!count || position >= limit) return
      const line = document.createElement('span')
      line.className = `colwork-table__frozen-boundary colwork-table__frozen-boundary--${axis}`
      line.setAttribute('aria-hidden', 'true')
      line.style.left = `${this.viewport.scrollLeft + (axis === 'column' ? position - 1 : 0)}px`
      line.style.top = `${this.viewport.scrollTop + (axis === 'row' ? position - 1 : 0)}px`
      if (axis === 'column') line.style.height = `${this.viewport.clientHeight}px`
      else line.style.width = `${this.viewport.clientWidth}px`
      this.viewport.append(line)
    }
    add('row', this.frozenRows, this.columnHeaderHeight + getViewportOffset(this.frozenRows, row => this.getRowHeight(row)), this.viewport.clientHeight)
    add('column', this.frozenColumns, this.rowHeaderWidth + getViewportOffset(this.frozenColumns, column => this.getColumnWidth(column)), this.viewport.clientWidth)
  }

  private refreshValues() {
    const active = document.activeElement
    this.table.querySelectorAll<HTMLTableCellElement>('td[data-key]').forEach((cell) => {
      const key = cell.dataset.key
      if (key && cell !== active && key !== this.editingKey) {
        const value = cell.querySelector<HTMLElement>('.colwork-table__cell-value')
        if (value) value.textContent = this.displayValue(key)
        else cell.textContent = this.displayValue(key)
      }
    })
  }

  private refreshSelection() {
    this.viewport.querySelectorAll('.colwork-table__selection').forEach((selection) => selection.remove())
    if (!this.selectionFocus) return
    const bounds = this.getSelectionBounds()
    this.table.querySelectorAll<HTMLElement>('th[data-selection-axis]').forEach(header => {
      const axis = header.dataset.selectionAxis
      const index = Number(header.dataset.selectionIndex)
      const selected = this.selectionMode === 'all' || (this.selectionMode === axis && (axis === 'row'
        ? index >= bounds.top && index <= bounds.bottom
        : index >= bounds.left && index <= bounds.right))
      header.classList.toggle('is-selected-header', selected)
    })
    this.addSelectionOverlay(selectionRange({ row: bounds.top, column: bounds.left }, { row: bounds.bottom, column: bounds.right }), 'colwork-table__selection', this.options.userColor ?? '#3b82f6', this.selectionMode)
  }

  private refreshCursors() {
    if (!this.table) return
    this.table.querySelectorAll<HTMLTableCellElement>('td[data-key]').forEach((cell) => {
      cell.querySelectorAll('.colwork-table__remote-cursor').forEach((cursor) => cursor.remove())
    })
    this.viewport.querySelectorAll('.colwork-table__remote-selection').forEach((selection) => selection.remove())
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID) return
      const selectionState = state.selection as AwarenessSelection | undefined
      if (selectionState?.anchor && selectionState.focus) {
        const remoteRange = remoteSelectionRange(selectionState, this.rowCount, this.columnCount)
        if (remoteRange) this.addSelectionOverlay(remoteRange, 'colwork-table__remote-selection', state.user?.color ?? '#94a3b8', selectionState.mode)
        const top = Math.min(selectionState.anchor.row, selectionState.focus.row)
        const left = Math.min(selectionState.anchor.column, selectionState.focus.column)
        const labelCell = this.table.querySelector<HTMLTableCellElement>(`td[data-key="${top}:${left}"]`)
        if (labelCell) this.addCursorLabel(labelCell, state, clientId)
      } else {
        const cursor = state.cursor as { row: number; column: number } | undefined
        const cursorCell = cursor && this.table.querySelector<HTMLTableCellElement>(`td[data-key="${cursor.row}:${cursor.column}"]`)
        if (cursorCell) this.addCursorLabel(cursorCell, state, clientId)
      }
    })
  }

  private addSelectionOverlay(range: ReturnType<typeof selectionRange>, className: string, color: string, mode?: SelectionMode) {
    if (this.frozenRows || this.frozenColumns) {
      this.addFrozenSelectionOverlay(range, className, color)
      return
    }
    const startRow = Math.max(0, Math.min(this.rowCount - 1, range.start.row))
    const startColumn = Math.max(0, Math.min(this.columnCount - 1, range.start.column))
    const endRow = Math.max(0, Math.min(this.rowCount - 1, range.end.row))
    const endColumn = Math.max(0, Math.min(this.columnCount - 1, range.end.column))
    if (startRow > endRow || startColumn > endColumn) return
    const columnSize = (column: number) => this.getColumnWidth(column)
    const rowSize = (row: number) => this.getRowHeight(row)
    const viewportRect = this.viewport.getBoundingClientRect()
    const tableRect = this.table.getBoundingClientRect()
    const firstCell = this.table.querySelector<HTMLTableCellElement>('td[data-key]')
    const firstKey = firstCell?.dataset.key?.split(':').map(Number)
    const firstRect = firstCell?.getBoundingClientRect()
    const logicalLeft = (column: number) => this.rowHeaderWidth + getViewportOffset(column, columnSize)
    const logicalTop = (row: number) => this.columnHeaderHeight + getViewportOffset(row, rowSize)
    const firstRowSpanHeight = firstCell && firstKey
      ? getViewportOffset(firstKey[0] + firstCell.rowSpan, rowSize) - getViewportOffset(firstKey[0], rowSize)
      : 0
    const rowScale = firstRect && firstRowSpanHeight ? firstRect.height / firstRowSpanHeight : 1
    const actualLeft = (column: number) => {
      const cell = this.table.querySelector<HTMLTableCellElement>(`td[data-key="${startRow}:${column}"]`)
      if (cell) return cell.getBoundingClientRect().left - viewportRect.left + this.viewport.scrollLeft
      if (!firstRect || !firstKey) return logicalLeft(column)
      return firstRect.left - viewportRect.left + this.viewport.scrollLeft + getViewportOffset(column, columnSize) - getViewportOffset(firstKey[1], columnSize)
    }
    const actualRight = (column: number) => {
      const cell = this.table.querySelector<HTMLTableCellElement>(`td[data-key="${endRow}:${column}"]`)
      if (cell) return cell.getBoundingClientRect().right - viewportRect.left + this.viewport.scrollLeft
      if (!firstRect || !firstKey) return logicalLeft(column + 1)
      return firstRect.left - viewportRect.left + this.viewport.scrollLeft + getViewportOffset(column + 1, columnSize) - getViewportOffset(firstKey[1], columnSize)
    }
    const actualTop = (row: number) => {
      const cell = this.table.querySelector<HTMLTableCellElement>(`td[data-key="${row}:${startColumn}"]`)
      if (cell) return cell.getBoundingClientRect().top - viewportRect.top + this.viewport.scrollTop
      if (!firstRect || !firstKey) return logicalTop(row)
      return firstRect.top - viewportRect.top + this.viewport.scrollTop + (getViewportOffset(row, rowSize) - getViewportOffset(firstKey[0], rowSize)) * rowScale
    }
    const actualBottom = (row: number) => {
      const cell = this.table.querySelector<HTMLTableCellElement>(`td[data-key="${row}:${endColumn}"]`)
      if (cell) return cell.getBoundingClientRect().bottom - viewportRect.top + this.viewport.scrollTop
      if (!firstRect || !firstKey) return logicalTop(row + 1)
      return firstRect.top - viewportRect.top + this.viewport.scrollTop + (getViewportOffset(row + 1, rowSize) - getViewportOffset(firstKey[0], rowSize)) * rowScale
    }
    const renderedRowCells = mode === 'row'
      ? Array.from(this.table.querySelectorAll<HTMLTableCellElement>('td[data-key]')).filter((cell) => cell.dataset.key?.startsWith(`${startRow}:`))
      : []
    const rowHeader = renderedRowCells[0]?.parentElement?.querySelector('th')
    const rowHeaderRect = rowHeader?.getBoundingClientRect()
    const left = mode === 'row' ? this.rowHeaderWidth : actualLeft(startColumn)
    const top = rowHeaderRect ? rowHeaderRect.top - viewportRect.top + this.viewport.scrollTop : actualTop(startRow)
    const right = mode === 'row' || mode === 'all'
      ? tableRect.right - viewportRect.left + this.viewport.scrollLeft
      : actualRight(endColumn)
    const bottom = rowHeaderRect && startRow === endRow
      ? rowHeaderRect.bottom - viewportRect.top + this.viewport.scrollTop
      : actualBottom(endRow)
    const overlay = document.createElement('span')
    overlay.className = className
    overlay.style.left = `${left}px`
    overlay.style.top = `${top}px`
    overlay.style.width = `${right - left}px`
    overlay.style.height = `${bottom - top}px`
    overlay.style.borderColor = color
    overlay.style.backgroundColor = colorWithAlpha(color, 0.1)
    this.viewport.append(overlay)
  }

  private addFrozenSelectionOverlay(range: CellRange, className: string, color: string) {
    const split = (start: number, end: number, frozen: number) => [
      { start, end: Math.min(end, frozen - 1), fixed: true },
      { start: Math.max(start, frozen), end, fixed: false },
    ].filter((part) => part.start <= part.end)
    const rowSize = (row: number) => this.getRowHeight(row)
    const columnSize = (column: number) => this.getColumnWidth(column)
    const frozenHeight = getViewportOffset(this.frozenRows, rowSize)
    const frozenWidth = getViewportOffset(this.frozenColumns, columnSize)
    for (const row of split(range.start.row, range.end.row, this.frozenRows)) {
      for (const column of split(range.start.column, range.end.column, this.frozenColumns)) {
        const x = this.viewport.scrollLeft
        const y = this.viewport.scrollTop
        const left = this.rowHeaderWidth + getViewportOffset(column.start, columnSize) + (column.fixed ? x : 0)
        const top = this.columnHeaderHeight + getViewportOffset(row.start, rowSize) + (row.fixed ? y : 0)
        const right = this.rowHeaderWidth + getViewportOffset(column.end + 1, columnSize) + (column.fixed ? x : 0)
        const bottom = this.columnHeaderHeight + getViewportOffset(row.end + 1, rowSize) + (row.fixed ? y : 0)
        const clippedLeft = Math.max(left, x + this.rowHeaderWidth + (column.fixed ? 0 : frozenWidth))
        const clippedTop = Math.max(top, y + this.columnHeaderHeight + (row.fixed ? 0 : frozenHeight))
        const clippedRight = Math.min(right, x + this.viewport.clientWidth)
        const clippedBottom = Math.min(bottom, y + this.viewport.clientHeight)
        if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) continue
        const overlay = document.createElement('span')
        overlay.className = className
        Object.assign(overlay.style, {
          left: `${clippedLeft}px`, top: `${clippedTop}px`,
          width: `${clippedRight - clippedLeft}px`, height: `${clippedBottom - clippedTop}px`,
          zIndex: '6', borderColor: color, backgroundColor: colorWithAlpha(color, 0.1),
        })
        this.viewport.append(overlay)
      }
    }
  }

  private addCursorLabel(cell: HTMLTableCellElement, state: any, clientId: number) {
    const marker = document.createElement('span')
    marker.className = 'colwork-table__remote-cursor'
    marker.style.backgroundColor = state.user?.color ?? '#64748b'
    marker.textContent = state.user?.name ?? String(clientId).slice(0, 6)
    cell.append(marker)
  }

  private startEdit(cell: HTMLTableCellElement, key: string, announce = true) {
    if (this.readOnly || this.isCellLocked(key)) return
    if (this.editingKey === key) return
    this.finishEdit(true)
    const currentCell = Array.from(this.table.querySelectorAll<HTMLTableCellElement>('td[data-key]'))
      .find((candidate) => candidate.dataset.key === key)
    if (currentCell) cell = currentCell
    this.editingKey = key
    this.editingOriginal = this.cells.get(key) ?? ''
    const input = document.createElement('textarea')
    input.className = 'colwork-table__editor'
    input.value = this.editingOriginal
    this.applyStyle(input, key)
    this.editor = input
    cell.classList.add('is-editing')
    cell.append(input)
    if (announce) this.sendAwareness({ ...(this.selectionFocus ?? { row: 0, column: 0 }), offset: 0 })
    input.addEventListener('blur', () => this.finishEdit(true), { once: true })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.ctrlKey && !event.shiftKey) input.blur()
      if (event.key === 'Escape') this.finishEdit(false)
    })
    input.focus()
    input.select()
  }

  private readStyle(key: string): CellStyle {
    try {
      return JSON.parse(this.styles.get(key) ?? '{}') as CellStyle
    } catch {
      return {}
    }
  }

  private applyStyle(element: HTMLElement, key: string) {
    const style = this.readStyle(key)
    element.style.fontWeight = style.bold ? '700' : ''
    element.style.fontStyle = style.italic ? 'oblique' : ''
    element.style.textDecoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ')
    element.style.transform = element.classList.contains('colwork-table__cell-value') && style.italic ? 'skewX(-8deg)' : ''
    element.style.fontSize = style.fontSize ? `${style.fontSize * this.zoomRatio}px` : ''
    element.style.color = style.color ?? ''
    element.style.backgroundColor = style.background ?? ''
    element.style.textAlign = style.align ?? ''
    if (element.classList.contains('colwork-table__cell-value')) element.style.whiteSpace = style.wrap ? 'pre-wrap' : 'pre'
    if (!element.classList.contains('colwork-table__cell-value') && !element.classList.contains('colwork-table__editor')) {
      element.style.borderTop = style.border?.top ? '2px solid #64748b' : ''
      element.style.borderRight = style.border?.right ? '2px solid #64748b' : ''
      element.style.borderBottom = style.border?.bottom ? '2px solid #64748b' : ''
      element.style.borderLeft = style.border?.left ? '2px solid #64748b' : ''
    }
  }

  private displayValue(key: string) {
    const value = this.cells.get(key) ?? ''
    const format = this.readStyle(key).format ?? 'general'
    if (!value || format === 'general') return value
    if (format === 'number') {
      const number = Number(value)
      return Number.isFinite(number) ? number.toLocaleString() : value
    }
    if (format === 'percent') {
      const number = Number(value.replace(/%$/, ''))
      return Number.isFinite(number) ? `${value.endsWith('%') ? number : number * 100}%` : value
    }
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10)
  }

  private toggleFormat(format: BooleanStyleKey) {
    if (this.readOnly || !this.selectedKey || this.selectionHasLocks()) return
    const { top, bottom, left, right } = this.getSelectionBounds()
    const current = this.readStyle(this.selectedKey)[format]
    this.doc.transact(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          const key = `${row}:${column}`
          const style = this.readStyle(key)
          style[format] = current ? false : true
          this.styles.set(key, JSON.stringify(style))
        }
      }
    })
    this.render()
  }

  private clearFormatting() {
    if (this.readOnly || !this.selectedKey || this.selectionHasLocks()) return
    const { top, bottom, left, right } = this.getSelectionBounds()
    this.doc.transact(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) this.styles.delete(cellKey({ row, column }))
      }
    })
    this.render()
  }

  private toggleBorder(mode: BorderMode) {
    if (this.readOnly || !this.selectedKey || this.selectionHasLocks()) return
    const { top, bottom, left, right } = this.getSelectionBounds()
    const sides = (row: number, column: number): Array<keyof CellBorder> => {
      const result: Array<keyof CellBorder> = []
      if (mode === 'outer') {
        if (row === top) result.push('top')
        if (row === bottom) result.push('bottom')
        if (column === left) result.push('left')
        if (column === right) result.push('right')
      }
      if (mode === 'inner' || mode === 'horizontal') if (row < bottom) result.push('bottom')
      if (mode === 'inner' || mode === 'vertical') if (column < right) result.push('right')
      return result
    }
    const targetCells = Array.from({ length: bottom - top + 1 }, (_, rowOffset) => Array.from({ length: right - left + 1 }, (_, columnOffset) => ({
      row: top + rowOffset,
      column: left + columnOffset,
    }))).flat()
    const targetSides = targetCells.flatMap(({ row, column }) => sides(row, column))
    if (!targetSides.length) return
    const enabled = !targetCells.every(({ row, column }) => sides(row, column).every((side) => this.readStyle(cellKey({ row, column })).border?.[side]))
    this.doc.transact(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          const key = cellKey({ row, column })
          const style = this.readStyle(key)
          const border = { ...(style.border ?? {}) }
          sides(row, column).forEach((side) => {
            if (enabled) border[side] = true
            else delete border[side]
          })
          if (Object.keys(border).length) style.border = border
          else delete style.border
          this.styles.set(key, JSON.stringify(style))
        }
      }
    })
    this.render()
  }

  private setStyle(format: 'color' | 'background' | 'align' | 'fontSize' | 'format', value: string | number | CellStyle['align'] | CellStyle['format']) {
    if (this.readOnly || !this.selectedKey || this.selectionHasLocks()) return
    const { top, bottom, left, right } = this.getSelectionBounds()
    this.doc.transact(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          const key = `${row}:${column}`
          const style = this.readStyle(key)
           if (format === 'align') style.align = value as CellStyle['align']
           else if (format === 'color') style.color = value as string
           else if (format === 'background') style.background = value as string
           else if (format === 'fontSize') style.fontSize = value as number
           else style.format = value as CellStyle['format']
          this.styles.set(key, JSON.stringify(style))
        }
      }
    })
    this.render()
  }

  private refreshStyles() {
    this.table.querySelectorAll<HTMLTableCellElement>('td[data-key]').forEach((cell) => {
      if (cell.dataset.key) {
        this.applyStyle(cell, cell.dataset.key)
        const value = cell.querySelector<HTMLElement>('.colwork-table__cell-value')
        if (value) {
          this.applyStyle(value, cell.dataset.key)
          value.textContent = this.displayValue(cell.dataset.key)
        }
      }
    })
  }

  private finishEdit(commit: boolean) {
    if (!this.editor || !this.editingKey) return
    const key = this.editingKey
    const editor = this.editor
    const nextValue = commit ? editor.value : this.editingOriginal
    // Removing a focused textarea fires blur synchronously. Clear state first to
    // keep the blur handler from re-entering and removing the same editor twice.
    this.editor = undefined
    this.editingKey = undefined
    this.editingOriginal = ''
    if (!this.isCellLocked(key) && nextValue !== this.cells.get(key)) this.cells.set(key, nextValue)
    const awarenessState = this.awareness.getLocalState() ?? {}
    this.awareness.setLocalState({ ...awarenessState, editing: null })
    editor.remove()
    const cell = this.table.querySelector<HTMLTableCellElement>(`td[data-key="${key}"]`)
    if (!cell) {
      this.render()
      return
    }
    this.table.querySelectorAll<HTMLTableCellElement>('td.is-editing').forEach((editingCell) => editingCell.classList.remove('is-editing'))
    const value = cell.querySelector<HTMLElement>('.colwork-table__cell-value') ?? document.createElement('span')
    value.className = 'colwork-table__cell-value'
    value.textContent = this.displayValue(key)
    if (!value.parentElement) cell.append(value)
    Array.from(cell.childNodes).forEach((node) => {
      if (node !== value && node.nodeType === Node.TEXT_NODE) node.remove()
    })
    this.applyStyle(cell, key)
    this.applyStyle(value, key)
    this.refreshSelection()
    this.refreshCursors()
  }

  destroy() {
    this.destroyed = true
    this.viewportResizeObserver.disconnect()
    this.closeLockMessage()
    this.passwordDialog?.close()
    this.finishEdit(true)
    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
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
    this.viewport.removeEventListener('copy', this.onCopy, true)
    this.viewport.removeEventListener('paste', this.onPaste, true)
    this.table.removeEventListener('mousedown', this.onTableMouseDown)
    window.removeEventListener('mouseup', this.onWindowMouseUp)
    window.removeEventListener('mousemove', this.onWindowMouseMove)
    window.removeEventListener('blur', this.onWindowBlur)
    document.removeEventListener('mousedown', this.onDocumentMouseDown)
    this.hideContextMenu()
    if (this.renderFrame !== undefined) cancelAnimationFrame(this.renderFrame)
    this.provider?.destroy()
    this.undoManager.destroy()
    this.doc.destroy()
    this.root.replaceChildren()
  }
}
