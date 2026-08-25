import { ColworkTable, rebuildYjsSnapshot } from '../src'
import { base64ToBytes } from '../src/yjsArchive'
import './test.css'

type InputData = { format?: string; snapshot?: { snapshot?: string } | string; updates?: Array<{ update?: string }> }

const snapshotInput = document.querySelector<HTMLTextAreaElement>('#snapshot-input')!
const updatesInput = document.querySelector<HTMLTextAreaElement>('#updates-input')!
const outputInput = document.querySelector<HTMLTextAreaElement>('#output-input')!
const status = document.querySelector<HTMLParagraphElement>('#viewer-status')!
const tableRoot = document.querySelector<HTMLDivElement>('#table-root')!
let table: ColworkTable | undefined

function downloadJson(fileName: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function snapshotBytes(data: InputData) {
  if (typeof data.snapshot === 'string') return data.snapshot
  return data.snapshot?.snapshot
}

function updateBytes(data: InputData) {
  return (data.updates ?? []).flatMap((record) => record.update ? [base64ToBytes(record.update)] : [])
}

function showSnapshot(text: string) {
  const data = JSON.parse(text) as InputData
  const snapshot = snapshotBytes(data)
  const updates = updateBytes(data)
  if (!snapshot && !updates.length) throw new Error('文件中没有 snapshot 或 updates')
  table?.destroy()
  table = new ColworkTable(tableRoot, { room: 'colwork-readonly', user: 'readonly', readOnly: true, snapshot: snapshot ? base64ToBytes(snapshot) : undefined, updates })
  status.textContent = `只读展示完成 · ${updates.length} 条 update`
}

function rebuild() {
  const result = rebuildYjsSnapshot(snapshotInput.value, updatesInput.value)
  outputInput.value = JSON.stringify(result, null, 2)
  status.textContent = `重建完成 · sequence=${result.sequence}`
}

function bindDrop(zoneId: string, target: HTMLTextAreaElement) {
  const zone = document.querySelector<HTMLSpanElement>(`#${zoneId}`)!
  zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('is-dragging') })
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'))
  zone.addEventListener('drop', (event) => {
    event.preventDefault()
    zone.classList.remove('is-dragging')
    const file = event.dataTransfer?.files[0]
    if (!file) return
    file.text().then((text) => { target.value = text; status.textContent = `已载入 ${file.name}，可以继续编辑或重建` }).catch((error) => { status.textContent = `读取失败：${String(error)}` })
  })
}

bindDrop('snapshot-drop', snapshotInput)
bindDrop('updates-drop', updatesInput)
document.querySelector<HTMLButtonElement>('#rebuild-button')!.addEventListener('click', () => {
  try { rebuild() } catch (error) { status.textContent = `重建失败：${String(error)}` }
})
document.querySelector<HTMLButtonElement>('#show-button')!.addEventListener('click', () => {
  try { showSnapshot(outputInput.value || snapshotInput.value || updatesInput.value) } catch (error) { status.textContent = `展示失败：${String(error)}` }
})
document.querySelector<HTMLButtonElement>('#download-button')!.addEventListener('click', () => {
  try { downloadJson('colwork.latest.snapshot.json', JSON.parse(outputInput.value)) } catch (error) { status.textContent = `下载失败：${String(error)}` }
})
