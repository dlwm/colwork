import { isSocketChunk, readSocketReceipt, sendSocketMessage, socketReceipt, SocketMessageReader } from './socketFrames'

const acknowledgments = new WeakMap<WebSocket, (signal?: AbortSignal) => Promise<void>>()

/** Resolves after the Colwork Worker has persisted preceding messages on this connection. */
export function waitForColworkSync(socket: WebSocket, signal?: AbortSignal) {
  const flush = acknowledgments.get(socket)
  if (!flush || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('协作连接未就绪'))
  return flush(signal)
}

/** WebSocket constructor for y-websocket providers connected to Colwork's Worker. */
export function createColworkWebSocket(): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const destination = new URL(url)
      destination.searchParams.set('colworkChunks', '1')
      super(destination, protocols)
      this.binaryType = 'arraybuffer'
      const reader = new SocketMessageReader()
      let sequence = 0
      const pending = new Map<number, () => void>()
      acknowledgments.set(this, signal => new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return }
        const id = ++sequence
        const cleanup = () => {
          clearTimeout(timeout)
          pending.delete(id)
          this.removeEventListener('close', interrupted)
          signal?.removeEventListener('abort', interrupted)
        }
        const interrupted = () => { cleanup(); reject(signal?.reason ?? new Error('协作已断开，重连后将补同步')) }
        const timeout = setTimeout(() => { cleanup(); reject(new Error('服务端尚未确认同步')) }, 30000)
        pending.set(id, () => { cleanup(); resolve() })
        this.addEventListener('close', interrupted, { once: true })
        signal?.addEventListener('abort', interrupted, { once: true })
        try { super.send(socketReceipt(id)) } catch (error) { cleanup(); reject(error) }
      }))
      this.addEventListener('message', event => {
        if (!(event.data instanceof ArrayBuffer)) return
        const bytes = new Uint8Array(event.data)
        const receipt = readSocketReceipt(bytes)
        if (receipt !== undefined) {
          event.stopImmediatePropagation()
          pending.get(receipt)?.()
          return
        }
        if (!isSocketChunk(bytes) && !reader.bytes) return
        event.stopImmediatePropagation()
        try {
          const message = reader.read(bytes)
          if (message) this.dispatchEvent(new MessageEvent('message', { data: message.buffer }))
        } catch { this.close(4002, 'Invalid collaboration chunks') }
      })
    }

    override send(data: Parameters<WebSocket['send']>[0]) {
      if (data instanceof Uint8Array && this.readyState === WebSocket.OPEN) {
        try { sendSocketMessage(data, frame => super.send(frame)) }
        catch { this.close(4009, 'Collaboration update too large') }
      } else super.send(data)
    }
  }
}
