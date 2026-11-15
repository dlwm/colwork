import type { ColworkViewPolicy } from './options'

const hostClass = 'colwork-table__watermark'
const hostCss = `
  :host {
    all: initial !important;
    display: block !important;
    position: relative !important;
    grid-area: 3 / 1 !important;
    place-self: stretch !important;
    min-width: 0 !important;
    min-height: 0 !important;
    contain: strict !important;
    overflow: hidden !important;
    z-index: 14 !important;
    pointer-events: none !important;
  }
  svg {
    display: block;
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
`

function normalizeLine(value: string | undefined) {
  const text = value?.trim().replace(/\s+/gu, ' ') ?? ''
  const characters = Array.from(text)
  return characters.length > 56 ? characters.slice(0, 55).join('') + '…' : text
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  doc: Document, tag: K, attributes: Record<string, string | number>,
) {
  const element = doc.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
  return element
}

function makePattern(doc: Document, lines: string[]) {
  const width = Math.max(240, ...lines.map(line => 52 + Array.from(line).length * 14))
  const height = 138
  const svg = svgElement(doc, 'svg', { width: '100%', height: '100%', focusable: 'false' })
  const defs = svgElement(doc, 'defs', {})
  const pattern = svgElement(doc, 'pattern', {
    id: 'colwork-watermark-pattern', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-24)', width, height,
  })
  const label = svgElement(doc, 'g', {
    'text-anchor': 'middle', 'font-family': 'system-ui, sans-serif', 'font-size': 14,
    'font-weight': 600, fill: '#25364d', stroke: '#fff', 'stroke-width': 1.25,
    'paint-order': 'stroke', opacity: .28,
  })
  for (const [index, line] of lines.entries()) {
    const text = svgElement(doc, 'text', { x: width / 2, y: height / 2 + index * 20 })
    text.textContent = line
    label.append(text)
  }
  pattern.append(label)
  defs.append(pattern)
  svg.append(defs, svgElement(doc, 'rect', { width: '100%', height: '100%', fill: 'url(#colwork-watermark-pattern)' }))
  return svg
}

export class TableWatermark {
  #overlay?: HTMLDivElement
  #observer?: MutationObserver
  #viewerText = ''
  #fixedText = ''

  constructor(private readonly shell: HTMLElement) {}

  setText(watermark: ColworkViewPolicy['watermark']) {
    const viewerText = normalizeLine(watermark?.viewerText)
    const fixedText = normalizeLine(watermark?.fixedText)
    if (viewerText === this.#viewerText && fixedText === this.#fixedText) return
    this.destroy()
    this.#viewerText = viewerText
    this.#fixedText = fixedText
    const lines = [viewerText, fixedText].filter(Boolean)
    if (!lines.length) return

    const doc = this.shell.ownerDocument
    const overlay = doc.createElement('div')
    const shadow = overlay.attachShadow({ mode: 'closed' })
    const Sheet = doc.defaultView?.CSSStyleSheet
    const sheet = Sheet && 'replaceSync' in Sheet.prototype && 'adoptedStyleSheets' in shadow ? new Sheet() : undefined
    sheet?.replaceSync(hostCss)

    const restoreDrawing = () => {
      shadow.replaceChildren(makePattern(doc, lines))
      if (sheet) {
        shadow.adoptedStyleSheets = [sheet]
      } else {
        const style = doc.createElement('style')
        style.textContent = hostCss
        shadow.prepend(style)
      }
    }
    const restoreHost = () => {
      for (const name of overlay.getAttributeNames()) {
        if (name !== 'class' && name !== 'aria-hidden') overlay.removeAttribute(name)
      }
      if (overlay.className !== hostClass) overlay.className = hostClass
      if (overlay.getAttribute('aria-hidden') !== 'true') overlay.setAttribute('aria-hidden', 'true')
      if (overlay.parentNode !== this.shell) this.shell.append(overlay)
    }
    restoreDrawing()
    restoreHost()
    const observer = new MutationObserver(records => {
      restoreHost()
      if (records.some(record => record.target !== overlay && record.target !== this.shell)) restoreDrawing()
      observer.takeRecords()
    })
    // Watch the watermark and its direct mount point. Table edits and scrolling do not touch this subtree.
    observer.observe(this.shell, { childList: true })
    observer.observe(overlay, { attributes: true })
    observer.observe(shadow, { childList: true, attributes: true, characterData: true, subtree: true })
    this.#overlay = overlay
    this.#observer = observer
  }

  destroy() {
    this.#observer?.disconnect()
    this.#overlay?.remove()
    this.#observer = undefined
    this.#overlay = undefined
    this.#viewerText = ''
    this.#fixedText = ''
  }
}
