export const maxSocketFrame = 1024 * 1024
export const maxSocketMessage = 48 * 1024 * 1024
const marker = 127
const header = 9

export function sendSocketMessage(bytes: Uint8Array, send: (frame: Uint8Array) => void) {
  if (bytes.byteLength <= maxSocketFrame) { send(bytes); return }
  if (bytes.byteLength > maxSocketMessage) throw new RangeError('协作数据单次最多 48 MiB')
  for (let offset = 0; offset < bytes.byteLength;) {
    const payload = bytes.subarray(offset, offset + maxSocketFrame - header)
    const frame = new Uint8Array(payload.length + header)
    frame[0] = marker
    const view = new DataView(frame.buffer)
    view.setUint32(1, bytes.byteLength)
    view.setUint32(5, offset)
    frame.set(payload, header)
    send(frame)
    offset += payload.length
  }
}

export class SocketMessageReader {
  private total = 0
  private chunks: Uint8Array[] = []
  bytes = 0

  get expectedBytes() { return this.total }

  read(frame: Uint8Array): Uint8Array | undefined {
    if (frame[0] !== marker) {
      if (this.bytes) throw new Error('Unexpected message during chunked sync')
      return frame
    }
    if (frame.byteLength <= header || frame.byteLength > maxSocketFrame) throw new Error('Invalid chunk size')
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const total = view.getUint32(1)
    const offset = view.getUint32(5)
    const payload = frame.subarray(header)
    if (total <= maxSocketFrame || total > maxSocketMessage || offset !== this.bytes
      || (offset && total !== this.total) || offset + payload.length > total
      || payload.length !== Math.min(total - offset, maxSocketFrame - header)) throw new Error('Invalid chunk order')
    this.total = total
    this.bytes += payload.length
    this.chunks.push(payload)
    if (this.bytes < total) return
    const message = new Uint8Array(total)
    let start = 0
    for (const chunk of this.chunks) { message.set(chunk, start); start += chunk.length }
    this.chunks = []
    this.bytes = 0
    return message
  }
}

export function isSocketChunk(frame: Uint8Array) { return frame[0] === marker }

export function socketReceipt(id: number) {
  const data = new Uint8Array(5)
  data[0] = 126
  new DataView(data.buffer).setUint32(1, id)
  return data
}

export function readSocketReceipt(data: Uint8Array) {
  if (data[0] !== 126 || data.byteLength !== 5) return
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1)
}
