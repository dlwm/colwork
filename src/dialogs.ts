import type { ProjectedMap } from './sheetCoordinates'
import { containsPosition, type CellPosition } from './range'
import { selectionRange } from './selection'
type DialogHost = {
  readOnly(): boolean
  destroyed(): boolean
  selectionFocus(): CellPosition | undefined
  selectionAnchor(): CellPosition | undefined
  restoreSelection(anchor: CellPosition | undefined, focus: CellPosition): void
  root(): HTMLElement
  locks: Pick<ProjectedMap<string>, 'entries'>
  hideMenu(): void
  setSelectionLocked(locked: boolean, password?: string): Promise<void>
}

export class TableDialogs {
  private messageDialog?: HTMLDialogElement
  private passwordDialog?: HTMLDialogElement
  constructor(private readonly host: DialogHost) {}
  close() {
    this.closeLockMessage()
    this.passwordDialog?.close()
    this.passwordDialog?.remove()
    this.passwordDialog = undefined
  }

  requestSelectionLock(locked: boolean, withPassword = false) {
    if (this.host.readOnly() || this.host.destroyed() || !this.host.selectionFocus() || this.passwordDialog) return
    this.closeLockMessage()
    const range = selectionRange(this.host.selectionAnchor(), this.host.selectionFocus())
    const needsPassword = withPassword || (!locked && Array.from(this.host.locks.entries()).some(([key, value]) => {
      const [row, column] = key.split(':').map(Number)
      return value !== '1' && containsPosition(range, { row, column })
    }))
    if (!needsPassword) {
      void this.host.setSelectionLocked(locked).catch(error => this.showLockMessage(error instanceof Error ? error.message : '操作失败'))
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
    const anchorValue = this.host.selectionAnchor()
    const anchor = anchorValue && { ...anchorValue }
    const focus = { ...this.host.selectionFocus()! }
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (submit.disabled) return
      if (locked && password.value !== confirmation.value) { error.textContent = '两次输入的密码不一致'; return }
      submit.disabled = true
      cancel.disabled = true
      dialog.oncancel = event => event.preventDefault()
      error.textContent = '正在处理…'
      try {
        this.host.restoreSelection(anchor, focus)
        await this.host.setSelectionLocked(locked, password.value)
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
    this.host.root().append(dialog)
    dialog.showModal()
    password.focus()
  }

  closeLockMessage() {
    const dialog = this.messageDialog
    this.messageDialog = undefined
    dialog?.close()
    dialog?.remove()
  }

  showLockMessage(message: string) {
    if (this.host.destroyed()) return
    this.closeLockMessage()
    this.host.hideMenu()
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
    this.host.root().append(dialog)
    dialog.showModal()
    confirm.focus()
  }

}
