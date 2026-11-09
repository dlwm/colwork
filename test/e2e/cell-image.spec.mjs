import { test, expect } from '@playwright/test'

const img = (page, root, key) => page.locator(`#${root} td[data-key="${key}"] img`)
const cell = (page, root, key) => page.locator(`#${root} td[data-key="${key}"]`)

async function mount(page) {
  await page.goto('/test/e2e/fixture.html')
  await page.evaluate(async () => {
    const { ColworkTable, Y, Awareness } = await import('/test/e2e/external-fixture.ts')
    window.ydoc = new Y.Doc()
    const images = {
      resolveUrl: id => id === 'asset-1' ? '/docs/brand/colwork-logo.png' : undefined,
      upload: file => {
        window.uploaded = file.name
        if (window.deferUpload) return new Promise(resolve => { window.resolveUpload = resolve })
        return Promise.resolve({ id: 'asset-1', alt: file.name })
      },
    }
    const options = { transport: 'external', collaboration: { document: ydoc, awareness: new Awareness(ydoc) }, user: 'Editor' }
    window.table = new ColworkTable(document.querySelector('#table'), { ...options, images })
    const root = document.body.appendChild(document.createElement('div'))
    root.id = 'peer'
    root.style.width = '1000px'
    window.viewer = new ColworkTable(root, { ...options, images: { resolveUrl: images.resolveUrl }, readOnly: true })
  })
}

test('picker uploads a file, shares the reference, and undo removes the rendered image', async ({ page }) => {
  await mount(page)
  await cell(page, 'table', '0:0').click()
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '插入图片' }).click(),
  ])
  await picker.setFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from([1]) })
  await expect(img(page, 'table', '0:0')).toHaveAttribute('alt', 'logo.png')
  await expect(img(page, 'peer', '0:0')).toHaveAttribute('alt', 'logo.png')
  await expect.poll(() => img(page, 'peer', '0:0').evaluate(node => node.naturalWidth)).toBeGreaterThan(0)
  expect(await page.evaluate(() => ydoc.getMap('cells').get('0:0'))).toBe('\u0000colwork:image:{"id":"asset-1","alt":"logo.png"}')
  await page.locator('#table button[title="撤销"]').click()
  await expect(img(page, 'table', '0:0')).toHaveCount(0)
  await expect(img(page, 'peer', '0:0')).toHaveCount(0)
})

test('paste uses the host and a pending upload preserves a newer cell edit', async ({ page }) => {
  await mount(page)
  await cell(page, 'table', '0:0').click()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([1])], 'paste.png', { type: 'image/png' }))
    document.querySelector('#table .colwork-table__viewport').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(img(page, 'peer', '0:0')).toHaveAttribute('alt', 'paste.png')
  const result = await page.evaluate(async () => {
    deferUpload = true
    const upload = table.insertImage(new File([new Uint8Array([1])], 'pending.png', { type: 'image/png' }), { row: 1, column: 0 })
    ydoc.getMap('cells').set('1:0', 'Remote text')
    resolveUpload({ id: 'asset-1', alt: 'pending.png' })
    return upload
  })
  expect(result).toBe(false)
  await expect(cell(page, 'peer', '1:0')).toHaveText('Remote text')
})
