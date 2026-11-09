import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import { ColworkWorkbook, getSheetMaps, setWorkbookSheetName } from '../src/index'
import { downloadXlsx, importWorkbookFile } from './workbook-files'
import { FormulaBook } from '../src/formulas'
import { cloudflareDeployment } from './user-settings'
import { demoImages } from './demo-images'
import './test.css'

const documentModel = new Y.Doc()
const awareness = new Awareness(documentModel)
const input = document.querySelector<HTMLInputElement>('#import')!
const download = document.querySelector<HTMLButtonElement>('#download')!
const status = document.querySelector<HTMLElement>('#status')!
const room = new URLSearchParams(location.search).get('room')
const websocketUrl = cloudflareDeployment
  ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rooms`
  : 'ws://127.0.0.1:1234'
const provider = room && /^[A-Za-z0-9_-]{1,64}$/.test(room)
  ? new WebsocketProvider(websocketUrl, `workbook-${room}`, documentModel, { awareness, connect: false, disableBc: true })
  : undefined

function seed() {
  const metadata = documentModel.getMap('colwork-metadata')
  if (metadata.get('initialized')) return
  documentModel.transact(() => {
    setWorkbookSheetName(documentModel, 'main', '项目清单')
    const maps = getSheetMaps(documentModel)
    const formulas = new FormulaBook(documentModel)
    for (const [index, row] of [
      ['项目', '预算', '状态'],
      ['导入示例', '240', '完成'],
      ['整理数据', '120', '待处理'],
      ['完善协作', '360', '进行中'],
      ['预算合计', '=SUM(B2:B4)', ''],
    ].entries()) row.forEach((value, column) => maps.cells.set(`${index}:${column}`, formulas.store(value)))
    metadata.set('initialized', true)
  })
}

if (!provider) seed()
const workbook = new ColworkWorkbook(document.querySelector('#table')!, {
  collaboration: { document: documentModel, awareness }, user: '示例查看者', readOnly: !!provider, images: demoImages,
})
let busy = false
function updateControls() {
  input.disabled = download.disabled = busy || (provider !== undefined && !provider.synced)
}
if (provider) {
  provider.on('sync', (synced: boolean) => {
    if (synced) seed()
    workbook.setReadOnly(!synced)
    status.textContent = synced ? '已加入共享工作簿' : '正在连接共享工作簿'
    updateControls()
  })
  status.textContent = '正在连接共享工作簿'
  provider.connect()
}
updateControls()

async function run(action: () => Promise<void>) {
  busy = true
  updateControls()
  status.textContent = '正在处理'
  try { await action(); status.textContent = '操作完成' }
  catch (error) { status.textContent = error instanceof Error ? error.message : 'Excel 操作失败' }
  finally { busy = false; input.value = ''; updateControls() }
}

input.onchange = () => {
  const file = input.files?.[0]
  if (!file) return
  void run(async () => {
    workbook.commitEditing()
    const [sheet] = await importWorkbookFile(documentModel, file, provider ? () => provider.synced : undefined)
    workbook.setActiveSheet(sheet)
  })
}
download.onclick = () => void run(async () => {
  workbook.commitEditing()
  await downloadXlsx(documentModel)
})
