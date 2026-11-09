const maxBytes = 512 * 1024
const maxImages = 40
const imageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const json = (value, status) => Response.json(value, { status })

function rasterType(bytes) {
  const matches = (offset, signature) => signature.every((value, index) => bytes[offset + index] === value)
  if (matches(0, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png'
  if (matches(0, [255, 216, 255])) return 'image/jpeg'
  if (matches(0, [71, 73, 70, 56, 55, 97]) || matches(0, [71, 73, 70, 56, 57, 97])) return 'image/gif'
  if (matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80])) return 'image/webp'
}

export async function handleDemoImage(sql, request) {
  sql.exec('CREATE TABLE IF NOT EXISTS demo_images (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL)')
  if (request.method === 'POST') {
    if (Number(request.headers.get('Content-Length')) > maxBytes) return json({ error: '演示图片最多 512 KB' }, 413)
    const reader = request.body?.getReader()
    if (!reader) return json({ error: '请选择图片' }, 400)
    const bytes = new Uint8Array(maxBytes)
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.length > maxBytes) {
        await reader.cancel()
        return json({ error: '演示图片最多 512 KB' }, 413)
      }
      bytes.set(value, size)
      size += value.length
    }
    const content = bytes.slice(0, size)
    const type = rasterType(content)
    if (!type) return json({ error: '请选择 PNG、JPEG、GIF 或 WebP 图片' }, 415)
    if (sql.exec('SELECT COUNT(*) AS count FROM demo_images').one().count >= maxImages) return json({ error: '本地演示图片已满' }, 507)
    const id = crypto.randomUUID()
    sql.exec('INSERT INTO demo_images (id, type, data) VALUES (?, ?, ?)', id, type, content.buffer)
    return json({ id }, 201)
  }
  const id = new URL(request.url).pathname.split('/').at(-1)
  if (request.method !== 'GET' || !imageId.test(id)) return json({ error: '图片不存在' }, 404)
  const entry = sql.exec('SELECT type, data FROM demo_images WHERE id = ?', id).toArray()[0]
  return entry ? new Response(entry.data, { headers: {
    'Content-Type': entry.type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
  } }) : json({ error: '图片不存在' }, 404)
}
