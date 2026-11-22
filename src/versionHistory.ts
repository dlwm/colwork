import type { YjsSnapshotFile } from './yjsArchive'
import type { WorkbookSnapshot } from './model'
import { compareWorkbookSnapshots } from './model-diff'
import { removeVersionPreviewValues, renderVersionPreview } from './versionPreview'
import type { ColworkViewPolicy } from './options'
import { TableWatermark } from './tableWatermark'

export type ColworkVersion = { id: string; createdAt: string; label?: string; author?: string }
export type ColworkVersionPage = { versions: ColworkVersion[]; nextCursor?: string }
export type ColworkVersionContext = { documentId: string; signal: AbortSignal }

/** The host controls authorization, retention, and restoration of the live document. */
export type ColworkVersionHistory = {
  documentId: string
  /** Include a client snapshot when the host persists it instead of taking a server-side snapshot. */
  captureClientSnapshot?: boolean
  list(input: ColworkVersionContext & { cursor?: string }): Promise<ColworkVersionPage>
  /** Read the authorized version on demand for a preview or comparison. */
  read?(input: ColworkVersionContext & { versionId: string }): Promise<WorkbookSnapshot>
  create?(input: ColworkVersionContext & { label?: string; snapshot?: YjsSnapshotFile }): Promise<ColworkVersion>
  restore?(input: ColworkVersionContext & { versionId: string }): Promise<void>
}

export class VersionHistoryDialog {
  private dialog?: HTMLDialogElement
  private preview?: HTMLElement
  private operation?: AbortController
  private watermark?: TableWatermark
  private watermarkText?: ColworkViewPolicy['watermark']
  private showValues = true
  constructor(private readonly root: HTMLElement, private readonly adapter: ColworkVersionHistory,
    private readonly canEdit: () => boolean, private readonly capture: () => YjsSnapshotFile | undefined, private readonly current: () => WorkbookSnapshot) {}

  setViewPolicy(policy: ColworkViewPolicy) {
    this.showValues = policy.versionPreview !== 'summary'
    if (!this.showValues && this.preview) removeVersionPreviewValues(this.preview)
    this.watermarkText = policy.watermark && { ...policy.watermark }
    this.watermark?.setText(this.watermarkText)
  }

  close() {
    this.operation?.abort()
    this.operation = undefined
    this.watermark?.destroy()
    this.watermark = undefined
    this.dialog?.remove()
    this.dialog = undefined
    this.preview = undefined
  }

  open() {
    if (this.dialog) return
    const doc = this.root.ownerDocument
    const dialog = doc.createElement('dialog')
    dialog.className = 'colwork-table__feature-dialog colwork-table__version-dialog'
    dialog.setAttribute('aria-label', '版本历史')
    const content = doc.createElement('div')
    content.className = 'colwork-table__version-dialog-content'
    const heading = doc.createElement('h3')
    heading.textContent = '版本历史'
    const list = doc.createElement('ol')
    const baseline = doc.createElement('select')
    baseline.setAttribute('aria-label', '对比基准')
    const currentVersion = doc.createElement('option')
    currentVersion.value = ''
    currentVersion.textContent = '当前工作簿'
    baseline.append(currentVersion)
    const versions = new Map<string, string>()
    const preview = doc.createElement('section')
    preview.className = 'colwork-table__version-preview'
    preview.setAttribute('aria-label', '版本差异')
    baseline.onchange = () => preview.replaceChildren()
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
      const controls = [...dialog.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')].filter(control => control !== close)
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
      const previousBaseline = baseline.value
      if (!append) {
        list.replaceChildren()
        preview.replaceChildren()
        baseline.replaceChildren(currentVersion)
        versions.clear()
      }
      for (const version of page.versions) {
        if (versions.has(version.id)) continue
        const item = doc.createElement('li')
        const date = new Date(version.createdAt)
        item.textContent = [version.label || '未命名版本',
          Number.isNaN(date.getTime()) ? version.createdAt : date.toLocaleString(), version.author].filter(Boolean).join(' · ')
        versions.set(version.id, item.textContent)
        if (this.adapter.read) {
          const read = this.adapter.read.bind(this.adapter)
          const option = doc.createElement('option')
          option.value = version.id
          option.textContent = item.textContent
          baseline.append(option)
          const previewButton = button('预览', () => {
            const baseId = baseline.value
            preview.replaceChildren()
            void request(async context => {
              const selected = read({ ...context, versionId: version.id })
              const reference = baseId === version.id ? selected
                : baseId ? read({ ...context, versionId: baseId }) : Promise.resolve().then(this.current)
              const [before, after] = await Promise.all([reference, selected])
              if (context.signal.aborted) return
              renderVersionPreview(preview, compareWorkbookSnapshots(before, after),
                versions.get(baseId) ?? '当前工作簿', versions.get(version.id)!, this.showValues)
            })
          })
          previewButton.setAttribute('aria-label', `预览 ${version.label || '未命名版本'}`)
          item.append(' ', previewButton)
        }
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
      baseline.value = versions.has(previousBaseline) ? previousBaseline : ''
      cursor = page.nextCursor
      more.hidden = !cursor
    }
    const more = button('加载更多', () => { void request(context => load(context, true)) })
    more.hidden = true
    const close = button('关闭', () => dialog.close())
    dialog.addEventListener('close', () => { if (this.dialog === dialog) this.close() }, { once: true })
    const refresh = button('刷新版本列表', () => { void request(context => load(context)) })
    content.append(heading, refresh)
    if (this.adapter.read) {
      const baselineLabel = doc.createElement('label')
      baselineLabel.append('对比基准', baseline)
      content.append(baselineLabel)
    }
    content.append(list, status, more, preview)
    if (this.adapter.create && this.canEdit()) {
      content.append(label, button('保存版本', () => {
        if (!this.canEdit()) return
        void request(async context => {
          await this.adapter.create!({ ...context, label: label.value.trim() || undefined, snapshot: this.adapter.captureClientSnapshot ? this.capture() : undefined })
          if (!context.signal.aborted) { label.value = ''; await load(context) }
        })
      }))
    }
    content.append(close)
    dialog.append(content)
    this.dialog = dialog
    this.preview = preview
    this.root.append(dialog)
    this.watermark = new TableWatermark(dialog, 'overlay')
    this.watermark.setText(this.watermarkText)
    dialog.showModal()
    void request(context => load(context))
  }
}
