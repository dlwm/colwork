import { imageLabel, type ColworkImageRef } from './cellImage'

export function renderCellContent(element: HTMLElement, text: string, image?: ColworkImageRef, resolve?: (id: string) => string | undefined) {
  if (image && resolve) {
    try {
      const source = resolve(image.id)
      const url = source && new URL(source, element.ownerDocument.baseURI)
      if (url && (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
        const previous = element.firstElementChild
        if (previous instanceof HTMLImageElement && previous.src === url.href) {
          previous.alt = imageLabel(image)
          return
        }
        const img = element.ownerDocument.createElement('img')
        img.className = 'colwork-table__cell-image'
        img.alt = imageLabel(image)
        img.draggable = false
        img.decoding = 'async'
        img.referrerPolicy = 'no-referrer'
        img.src = url.href
        element.replaceChildren(img)
        return
      }
    } catch { /* Use the image label if the host can't resolve its URL. */ }
  }
  element.textContent = image ? imageLabel(image) : text
}
