import { ColworkTable } from './ColworkTable'
import type { ColworkRowView, ColworkViewPolicy, ExternalCollaborationOptions } from './options'
import { addWorkbookSheet, listWorkbookSheets, moveWorkbookSheet, removeWorkbookSheet, setWorkbookSheetName, workbookOrderRoot, workbookRoot } from './workbookModel'

export type ColworkWorkbookOptions = Omit<ExternalCollaborationOptions, 'transport' | 'sheetId'>

/** Shares workbook content while keeping the active tab and each tab's view local. */
export class ColworkWorkbook {
  private readonly tabs: HTMLElement
  private readonly container: HTMLElement
  private readonly status: HTMLElement
  private readonly document
  private readonly views = new Map<string, ColworkRowView>()
  private draggedSheet?: string
  private table?: ColworkTable
  private sheetId?: string
  private readOnly: boolean
  private viewPolicy?: ColworkViewPolicy
  private destroyed = false

  constructor(private readonly root: HTMLElement, private readonly options: ColworkWorkbookOptions) {
    this.document = options.collaboration.document
    this.readOnly = options.readOnly === true
    this.viewPolicy = options.viewPolicy
    const doc = root.ownerDocument
    this.tabs = doc.createElement('div')
    this.tabs.className = 'colwork-workbook__tabs'
    this.tabs.setAttribute('aria-label', '工作表')
    this.status = doc.createElement('span')
    this.status.className = 'colwork-workbook__status'
    this.status.setAttribute('role', 'status')
    this.container = doc.createElement('div')
    root.replaceChildren(this.tabs, this.status, this.container)
    this.document.getMap(workbookRoot).observe(this.refresh)
    this.document.getArray(workbookOrderRoot).observe(this.refresh)
    this.refresh()
  }

  private refresh = () => {
    if (this.destroyed) return
    const sheets = listWorkbookSheets(this.document)
    if (!sheets.some(sheet => sheet.id === this.sheetId)) this.mount(sheets[0].id, false)
    const button = (label: string, action: () => void) => {
      const item = this.root.ownerDocument.createElement('button')
      item.type = 'button'
      item.textContent = label
      item.onclick = () => {
        this.status.textContent = ''
        try { action() } catch (error) { this.status.textContent = error instanceof Error ? error.message : '操作失败' }
      }
      this.tabs.append(item)
      return item
    }
    this.tabs.replaceChildren()
    for (const sheet of sheets) {
      const item = button(sheet.name, () => this.setActiveSheet(sheet.id))
      item.setAttribute('aria-pressed', String(sheet.id === this.sheetId))
      if (this.readOnly) continue
      item.draggable = true
      item.ondragstart = event => {
        this.draggedSheet = sheet.id
        event.dataTransfer?.setData('text/plain', sheet.name)
      }
      item.ondragend = () => { this.draggedSheet = undefined }
      item.ondragover = event => { if (this.draggedSheet) event.preventDefault() }
      item.ondrop = event => {
        event.preventDefault()
        const id = this.draggedSheet
        this.draggedSheet = undefined
        if (!id || id === sheet.id || this.readOnly || !listWorkbookSheets(this.document).some(tab => tab.id === id)) return
        const remaining = listWorkbookSheets(this.document).filter(tab => tab.id !== id)
        const after = event.clientX > item.getBoundingClientRect().left + item.offsetWidth / 2
        const index = remaining.findIndex(tab => tab.id === sheet.id)
        moveWorkbookSheet(this.document, id, after ? remaining[index + 1]?.id : sheet.id)
      }
      item.onkeydown = event => {
        if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault()
        const index = sheets.indexOf(sheet)
        if (event.key === 'ArrowLeft' && index > 0) moveWorkbookSheet(this.document, sheet.id, sheets[index - 1].id)
        if (event.key === 'ArrowRight' && index < sheets.length - 1) moveWorkbookSheet(this.document, sheet.id, sheets[index + 2]?.id)
        this.tabs.querySelectorAll('button')[listWorkbookSheets(this.document).findIndex(tab => tab.id === sheet.id)]?.focus()
      }
    }
    if (this.readOnly) button('排序筛选', () => this.table?.openRowView())
    else {
      button('新增工作表', () => {
        let index = sheets.length + 1
        while (sheets.some(sheet => sheet.name === `工作表${index}`)) index++
        this.setActiveSheet(addWorkbookSheet(this.document, `工作表${index}`))
      })
      button('重命名工作表', () => {
        const sheet = sheets.find(sheet => sheet.id === this.sheetId)!
        const name = this.root.ownerDocument.defaultView?.prompt('工作表名称', sheet.name)
        if (name !== null && name !== undefined) setWorkbookSheetName(this.document, sheet.id, name)
      })
      button('删除工作表', () => {
        const sheet = sheets.find(sheet => sheet.id === this.sheetId)!
        if (this.root.ownerDocument.defaultView?.confirm(`删除工作表「${sheet.name}」？`)) removeWorkbookSheet(this.document, sheet.id)
      }).disabled = sheets.length <= 1
    }
  }

  private mount(id: string, commit: boolean) {
    if (this.table && this.sheetId) {
      if (commit) this.table.commitEditing()
      if (!this.options.personalViewKey) this.views.set(this.sheetId, this.table.getRowView())
      this.table.destroy()
    }
    this.options.onEditingChange?.({ editing: false, dirty: false })
    this.sheetId = id
    this.table = new ColworkTable(this.container, {
      ...this.options, transport: 'external', sheetId: id, readOnly: this.readOnly, viewPolicy: this.viewPolicy,
    })
    const view = this.views.get(id)
    if (view) {
      try { this.table.setRowView(view) } catch { this.views.delete(id) }
    }
  }

  getActiveSheetId() { return this.sheetId }

  setActiveSheet(id: string) {
    if (this.destroyed || id === this.sheetId) return
    if (!listWorkbookSheets(this.document).some(sheet => sheet.id === id)) throw new RangeError('工作表不存在')
    this.mount(id, true)
    this.refresh()
  }

  setReadOnly(value: boolean) {
    if (this.destroyed || this.readOnly === value) return
    this.readOnly = value
    this.table?.setReadOnly(value)
    this.refresh()
  }

  setViewPolicy(policy: ColworkViewPolicy) {
    this.viewPolicy = structuredClone(policy)
    this.table?.setViewPolicy(policy)
  }

  openVersionHistory() { this.table?.openVersionHistory() }
  commitEditing() { this.table?.commitEditing() }
  canExport() { return this.table?.canExport() ?? false }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.document.getMap(workbookRoot).unobserve(this.refresh)
    this.document.getArray(workbookOrderRoot).unobserve(this.refresh)
    this.table?.destroy()
    this.root.replaceChildren()
  }
}
