import * as Y from 'yjs'

export async function importWorkbookFile(document: Y.Doc, file: File, canSync?: () => boolean) {
  const { importXlsx, MAX_XLSX_BYTES } = await import('../src/xlsx')
  if (file.size > MAX_XLSX_BYTES) throw new RangeError('Excel 文件最多 10 MB')
  const bytes = await file.arrayBuffer()
  if (!canSync) return importXlsx(document, bytes)
  const staged = new Y.Doc()
  try {
    Y.applyUpdate(staged, Y.encodeStateAsUpdate(document))
    const before = Y.encodeStateVector(staged)
    // Imports append new sheets, preserving edits made by peers during parsing.
    const sheets = await importXlsx(staged, bytes, { canApply: canSync })
    const update = Y.encodeStateAsUpdate(staged, before)
    if (update.byteLength > 1024 * 1024 - 32) throw new RangeError('导入后的协作更新过大，请拆分文件后再导入')
    if (!canSync()) throw new Error('当前无法编辑工作簿，导入已取消')
    Y.applyUpdate(document, update)
    return sheets
  } finally { staged.destroy() }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function downloadXlsx(document: Y.Doc) {
  const { exportXlsx } = await import('../src/xlsx')
  const file = await exportXlsx(document)
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  downloadBlob(new Blob([new Uint8Array(file)], { type }), 'colwork.xlsx')
}
