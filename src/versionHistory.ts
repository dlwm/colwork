import type { YjsSnapshotFile } from './yjsArchive'

export type ColworkVersion = { id: string; createdAt: string; label?: string; author?: string }
export type ColworkVersionPage = { versions: ColworkVersion[]; nextCursor?: string }
export type ColworkVersionContext = { documentId: string; signal: AbortSignal }

/** The host controls authorization, retention, and restoration of the live document. */
export type ColworkVersionHistory = {
  documentId: string
  /** Include a client snapshot when the host persists it instead of taking a server-side snapshot. */
  captureClientSnapshot?: boolean
  list(input: ColworkVersionContext & { cursor?: string }): Promise<ColworkVersionPage>
  create?(input: ColworkVersionContext & { label?: string; snapshot?: YjsSnapshotFile }): Promise<ColworkVersion>
  restore?(input: ColworkVersionContext & { versionId: string }): Promise<void>
}

export class VersionHistoryDialog {
  private dialog?: HTMLDialogElement
  private operation?: AbortController
  constructor(private readonly root: HTMLElement, private readonly adapter: ColworkVersionHistory,
    private readonly canEdit: () => boolean, private readonly capture: () => YjsSnapshotFile | undefined) {}

  close() {
    this.operation?.abort()
    this.operation = undefined
    this.dialog?.remove()
    this.dialog = undefined
  }

  open() {
    if (this.dialog) return
    const doc = this.root.ownerDocument
    const dialog = doc.createElement('dialog')
    dialog.className = 'colwork-table__feature-dialog'
    dialog.setAttribute('aria-label', '版本历史')
    const heading = doc.createElement('h3')
    heading.textContent = '版本历史'
    const list = doc.createElement('ol')
    const status = doc.createElement('p')
    status.setAttribute('role', 'status')
    const label = doc.createElement('input')
    label.placeholder = '版本说明（可选）'
    label.setAttribute('aria-label', '版本说明')
    label.maxLength = 120
    const button = (name: string, action: () => void) => {
      const element = doc.createElement('button')
      element.type = 'button'
      element.textContent = name
      element.onclick = action
      return element
    }
    let cursor: string | undefined
    const request = async (work: (context: ColworkVersionContext) => Promise<void>) => {
      if (this.operation || !dialog.open) return
      const operation = new AbortController()
      this.operation = operation
      const controls = [...dialog.querySelectorAll('button')].filter(control => control !== close)
      controls.forEach(control => { control.disabled = true })
      status.textContent = '正在处理…'
      try {
        await work({ documentId: this.adapter.documentId, signal: operation.signal })
        if (!operation.signal.aborted) status.textContent = list.childElementCount ? '' : '暂无版本'
      } catch (error) {
        if (!operation.signal.aborted) status.textContent = error instanceof Error ? error.message : '操作失败'
      } finally {
        if (this.operation === operation) this.operation = undefined
        controls.forEach(control => { control.disabled = false })
      }
    }
    const load = async (context: ColworkVersionContext, append = false) => {
      const page = await this.adapter.list({ ...context, cursor: append ? cursor : undefined })
      if (context.signal.aborted) return
      if (!append) list.replaceChildren()
      for (const version of page.versions) {
        const item = doc.createElement('li')
        const date = new Date(version.createdAt)
        item.textContent = [version.label || '未命名版本',
          Number.isNaN(date.getTime()) ? version.createdAt : date.toLocaleString(), version.author].filter(Boolean).join(' · ')
        if (this.adapter.restore && this.canEdit()) {
          item.append(' ', button('恢复', () => {
            if (!this.canEdit() || !doc.defaultView?.confirm('恢复此版本会修改当前共享文档。确定继续？')) return
            void request(async context => {
              await this.adapter.restore!({ ...context, versionId: version.id })
              if (!context.signal.aborted) await load(context)
            })
          }))
        }
        list.append(item)
      }
      cursor = page.nextCursor
      more.hidden = !cursor
    }
    const more = button('加载更多', () => { void request(context => load(context, true)) })
    more.hidden = true
    const close = button('关闭', () => dialog.close())
    dialog.addEventListener('close', () => { if (this.dialog === dialog) this.close() }, { once: true })
    const refresh = button('刷新版本列表', () => { void request(context => load(context)) })
    dialog.append(heading, refresh, list, status, more)
    if (this.adapter.create && this.canEdit()) {
      dialog.append(label, button('保存版本', () => {
        if (!this.canEdit()) return
        void request(async context => {
          await this.adapter.create!({ ...context, label: label.value.trim() || undefined, snapshot: this.adapter.captureClientSnapshot ? this.capture() : undefined })
          if (!context.signal.aborted) { label.value = ''; await load(context) }
        })
      }))
    }
    dialog.append(close)
    this.dialog = dialog
    this.root.append(dialog)
    dialog.showModal()
    void request(context => load(context))
  }
}
