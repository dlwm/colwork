import * as Y from 'yjs'
import type { ColworkImageOptions } from '../src/options'
import { maxSocketFrame, maxSocketMessage } from '../src/socketFrames'

export async function importWorkbookFile(document: Y.Doc, file: File, canSync?: () => boolean, chunked = false, images?: ColworkImageOptions, confirm?: () => Promise<void>) {
  const { importXlsx, MAX_XLSX_BYTES } = await import('../src/xlsx')
  if (file.size > MAX_XLSX_BYTES) throw new RangeError('Excel 文件最多 10 MB')
  const bytes = await file.arrayBuffer()
  const options = {
    canApply: canSync,
    uploadImage: images?.upload ? (image: { bytes: Uint8Array; mimeType: string; name: string }) =>
      images.upload!(new File([Uint8Array.from(image.bytes)], image.name, { type: image.mimeType })) : undefined,
  }
  if (!canSync) return importXlsx(document, bytes, options)
  const staged = new Y.Doc()
  try {
    Y.applyUpdate(staged, Y.encodeStateAsUpdate(document))
    const before = Y.encodeStateVector(staged)
    // Imports append new sheets, preserving edits made by peers during parsing.
    const sheets = await importXlsx(staged, bytes, options)
    const update = Y.encodeStateAsUpdate(staged, before)
    if (update.byteLength > (chunked ? maxSocketMessage : maxSocketFrame) - 32) throw new RangeError('导入后的协作更新过大，请拆分文件后再导入')
    if (!canSync()) throw new Error('当前无法编辑工作簿，导入已取消')
    Y.applyUpdate(document, update)
    await confirm?.()
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

export async function downloadXlsx(document: Y.Doc, images?: ColworkImageOptions) {
  const { exportXlsx } = await import('../src/xlsx')
  const file = await exportXlsx(document, { readImage: images ? async image => {
    const url = images.resolveUrl(image.id)
    if (!url) return
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('无法获取 Excel 中的图片')
    return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType: response.headers.get('content-type')?.split(';')[0] ?? '' }
  } : undefined })
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  downloadBlob(new Blob([new Uint8Array(file)], { type }), 'colwork.xlsx')
}
