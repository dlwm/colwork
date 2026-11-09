export type ColworkImageRef = { id: string; alt?: string }

const marker = '\u0000colwork:image:'
const control = /[\u0000-\u001f\u007f]/u

export function encodeCellImage(image: ColworkImageRef) {
  if (typeof image?.id !== 'string' || !image.id.trim() || image.id.length > 512 || control.test(image.id)
    || (image.alt !== undefined && (typeof image.alt !== 'string' || image.alt.length > 160 || control.test(image.alt)))) {
    throw new TypeError('图片上传接口返回了无效的资源信息')
  }
  return marker + JSON.stringify({ id: image.id, alt: image.alt })
}

export function readCellImage(value?: string): ColworkImageRef | undefined {
  if (!value?.startsWith(marker) || value.length > 4096) return undefined
  try {
    const image = JSON.parse(value.slice(marker.length)) as ColworkImageRef
    encodeCellImage(image)
    return image
  } catch { return undefined }
}

export function imageLabel(image: ColworkImageRef) { return image.alt || '图片' }
