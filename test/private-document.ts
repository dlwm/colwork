import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import { ColworkWorkbook, type ColworkViewPolicy } from '../src/index'
import { downloadBlob, downloadXlsx, importWorkbookFile } from './workbook-files'
import './test.css'

const container = document.querySelector<HTMLElement>('#table')!
const download = document.querySelector<HTMLButtonElement>('#download')!
const xlsx = document.querySelector<HTMLButtonElement>('#xlsx')!
const input = document.querySelector<HTMLInputElement>('#import')!
const status = document.querySelector<HTMLElement>('#status')!
const room = new URLSearchParams(location.search).get('id') ?? ''

function errorMessage(response: Response) {
  if (response.status === 401) return '请先在宿主应用登录'
  if (response.status === 403) return '当前登录账号没有此权限'
  return '无法完成请求'
}

async function mountDocument() {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(room)) throw new Error('无效的文档标识')
  const api = `/api/documents/${room}`
  const response = await fetch(`${api}/view-policy`, { cache: 'no-store' })
  if (!response.ok) throw new Error(errorMessage(response))
  const access: { displayName: string; canEdit: boolean; viewPolicy: ColworkViewPolicy } = await response.json()
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)
  const socketUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rooms/private`
  const provider = new WebsocketProvider(socketUrl, room, ydoc, { awareness, connect: false, disableBc: true })
  let dirty = false
  let busy = false
  let expired = false
  function updateDownload() {
    download.disabled = xlsx.disabled = expired || access.viewPolicy.allowExport !== true || !provider.synced || dirty || busy
    input.disabled = expired || !access.canEdit || !provider.synced || busy
  }
  const table = new ColworkWorkbook(container, {
    collaboration: { document: ydoc, awareness }, user: access.displayName,
    readOnly: true, viewPolicy: access.viewPolicy,
    onEditingChange(state) { dirty = state.dirty; updateDownload() },
  })
  provider.on('sync', (synced: boolean) => {
    table.setReadOnly(!synced || !access.canEdit)
    status.textContent = synced ? access.displayName : '正在连接文档'
    updateDownload()
  })
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (event?.code === 1008) {
      expired = true
      provider.disconnect()
      table.destroy()
      updateDownload()
      status.textContent = '登录已过期，请重新打开文档'
    }
  })
  const exportFile = async (excel: boolean) => {
    if (download.disabled) return
    busy = true
    updateDownload()
    try {
      const result = await fetch(`${api}/export`, { cache: 'no-store' })
      if (!result.ok) throw new Error(errorMessage(result))
      if (excel) {
        const archive = await result.json()
        const document = new Y.Doc()
        try {
          Y.applyUpdate(document, Uint8Array.from(atob(archive.snapshot), value => value.charCodeAt(0)))
          await downloadXlsx(document)
        } finally { document.destroy() }
      } else downloadBlob(await result.blob(), 'colwork.snapshot.json')
      status.textContent = access.displayName
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '导出失败'
    } finally {
      busy = false
      updateDownload()
    }
  }
  download.onclick = () => void exportFile(false)
  xlsx.onclick = () => void exportFile(true)
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file || input.disabled) return
    table.commitEditing()
    busy = true
    updateDownload()
    try {
      const [sheet] = await importWorkbookFile(ydoc, file, () => !expired && provider.synced && access.canEdit)
      table.setActiveSheet(sheet)
    } catch (error) { status.textContent = error instanceof Error ? error.message : '导入失败' }
    finally { busy = false; input.value = ''; updateDownload() }
  }
  provider.connect()
  window.addEventListener('pagehide', () => {
    table.destroy()
    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  }, { once: true })
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload() })
}

mountDocument().catch(error => { status.textContent = error.message })
