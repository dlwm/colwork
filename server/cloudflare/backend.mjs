import { DurableObject } from 'cloudflare:workers'
import { Y, createPresence, syncRequest, syncUpdate, awarenessMessage, receiveMessage, removePresence } from './protocol.mjs'

const chunkSize = 64 * 1024
const json = (value, status = 200) => Response.json(value, { status })

export class ColworkRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.queues = new Map()
    this.doc = new Y.Doc()
    this.sql = ctx.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS snapshot_chunks (position INTEGER PRIMARY KEY, data BLOB)')
    this.sql.exec('CREATE TABLE IF NOT EXISTS user_settings (id TEXT PRIMARY KEY, settings TEXT)')
    const parts = this.sql.exec('SELECT data FROM snapshot_chunks ORDER BY position').toArray()
    if (parts.length) {
      const size = parts.reduce((total, part) => total + part.data.byteLength, 0)
      const update = new Uint8Array(size)
      let offset = 0
      for (const part of parts) { update.set(new Uint8Array(part.data), offset); offset += part.data.byteLength }
      Y.applyUpdate(this.doc, update)
    }
    this.presence = createPresence(this.doc.clientID, message => this.broadcast(message))
    for (const socket of ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue
      for (const entry of socket.deserializeAttachment()?.presence ?? []) {
        if ((this.presence.meta.get(entry.id)?.clock ?? -1) <= entry.clock) {
          this.presence.meta.set(entry.id, { clock: entry.clock, lastUpdated: Date.now() })
          if (entry.value !== null) this.presence.states.set(entry.id, entry.value)
          else this.presence.states.delete(entry.id)
        }
      }
    }
    this.doc.on('update', update => {
      // Chunk snapshots so a growing sheet never exceeds one storage value limit.
      const snapshot = Y.encodeStateAsUpdate(this.doc)
      ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM snapshot_chunks')
        for (let offset = 0; offset < snapshot.length; offset += chunkSize) {
          this.sql.exec('INSERT INTO snapshot_chunks (position, data) VALUES (?, ?)', offset / chunkSize, snapshot.slice(offset, offset + chunkSize))
        }
      })
      this.broadcast(syncUpdate(update))
    })
  }

  broadcast(message) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(message) } catch { this.webSocketClose(socket) }
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/api/users' && request.method === 'POST') {
      try {
        const text = await request.text()
        if (text.length > 8192) return json({ error: 'User settings too large' }, 413)
        const value = JSON.parse(text)
        const id = String(value.id ?? '')
        if (!id || id.length > 128) return json({ error: 'Invalid user id' }, 400)
        const settings = { id, nickname: String(value.nickname ?? '').slice(0, 80), color: String(value.color ?? '').slice(0, 32), delay: Math.max(0, Math.min(30000, Number(value.delay) || 0)) }
        this.sql.exec('INSERT OR REPLACE INTO user_settings (id, settings) VALUES (?, ?)', id, JSON.stringify(settings))
        return json(settings)
      } catch { return json({ error: 'Invalid user settings' }, 400) }
    }
    if (url.pathname.startsWith('/internal/users/')) {
      const id = decodeURIComponent(url.pathname.slice('/internal/users/'.length))
      const row = this.sql.exec('SELECT settings FROM user_settings WHERE id = ?', id).toArray()[0]
      return json(row ? JSON.parse(row.settings) : { delay: 0 })
    }
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426)
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ delay: Number(request.headers.get('x-colwork-delay')) || 0, presence: [] })
    server.send(syncRequest(this.doc))
    if (this.presence.states.size) server.send(awarenessMessage(this.presence, [...this.presence.states.keys()]))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket, message) {
    if ((message.byteLength ?? message.length) > 1024 * 1024) { socket.close(1009, 'Message too large'); return }
    // Preserve per-socket ordering when test latency is enabled.
    const previous = this.queues.get(socket) ?? Promise.resolve()
    const current = previous.then(async () => {
      const delay = socket.deserializeAttachment()?.delay ?? 0
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (socket.readyState === WebSocket.OPEN) receiveMessage(this.doc, this.presence, socket, message)
    }).catch(() => { socket.close(1003, 'Invalid collaboration message') })
    this.queues.set(socket, current)
    await current
    if (this.queues.get(socket) === current) this.queues.delete(socket)
  }

  webSocketClose(socket) {
    removePresence(this.presence, socket)
    // Complete the server half of the closing handshake for hibernating sockets.
    try { socket.close(1000, 'Connection closed') } catch {}
  }
  webSocketError(socket) {
    removePresence(this.presence, socket)
    try { socket.close(1011, 'Connection error') } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return json({ status: 'ok', service: 'colwork-backend' })
    if (url.pathname === '/api/users') return env.ROOMS.getByName('users').fetch(request)
    const match = url.pathname.match(/^\/rooms\/([^/]+)$/)
    if (match) {
      let room
      try { room = decodeURIComponent(match[1]) } catch { return json({ error: 'Invalid room' }, 400) }
      if (!room || room.length > 128) return json({ error: 'Invalid room' }, 400)
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426)
      const settingsURL = new URL(`/internal/users/${encodeURIComponent(url.searchParams.get('userId') ?? '')}`, url)
      const settings = await (await env.ROOMS.getByName('users').fetch(settingsURL)).json()
      const headers = new Headers(request.headers)
      headers.set('x-colwork-delay', String(settings.delay))
      return env.ROOMS.getByName(`room:${room}`).fetch(new Request(request, { headers }))
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rooms/')) return json({ error: 'Not found' }, 404)
    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'Not found' }, 404)
  },
}
