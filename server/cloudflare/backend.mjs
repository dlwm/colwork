import { DurableObject } from 'cloudflare:workers'
import { Y, createPresence, syncRequest, syncUpdate, awarenessMessage, receiveMessage, removePresence } from './protocol.mjs'
import { documentAccess, documentIdPattern, privateJson } from './document-access.mjs'
import { exportYjsSnapshot } from '../../src/model.ts'
import { handleDemoImage } from './demo-images.mjs'
import { isSocketChunk, maxSocketFrame, maxSocketMessage, readSocketReceipt, sendSocketMessage, SocketMessageReader } from '../../src/socketFrames.ts'

const chunkSize = 64 * 1024
const json = (value, status = 200) => Response.json(value, { status })

export class ColworkRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.queues = new Map()
    this.chunkReaders = new Map()
    this.doc = new Y.Doc()
    this.sql = ctx.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS snapshot_chunks (position INTEGER PRIMARY KEY, data BLOB)')
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_updates (sequence INTEGER, position INTEGER, data BLOB, PRIMARY KEY(sequence, position))')
    this.sql.exec('CREATE TABLE IF NOT EXISTS user_settings (id TEXT PRIMARY KEY, settings TEXT)')
    const parts = this.sql.exec('SELECT data FROM snapshot_chunks ORDER BY position').toArray()
    this.applyParts(parts)
    const updates = this.sql.exec('SELECT sequence, position, data FROM room_updates ORDER BY sequence, position').toArray()
    let entries = []
    this.sequence = 0
    this.journalBytes = 0
    for (const part of updates) {
      if (part.sequence !== this.sequence) {
        this.applyParts(entries)
        entries = []
        this.sequence = part.sequence
      }
      entries.push(part)
      this.journalBytes += part.data.byteLength
    }
    this.applyParts(entries)
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
      this.persistUpdate(update)
      this.broadcast(syncUpdate(update))
    })
  }

  applyParts(parts) {
    if (!parts.length) return
    const update = new Uint8Array(parts.reduce((total, part) => total + part.data.byteLength, 0))
    let offset = 0
    for (const { data } of parts) { update.set(new Uint8Array(data), offset); offset += data.byteLength }
    Y.applyUpdate(this.doc, update)
  }

  persistUpdate(update) {
    const sequence = this.sequence + 1
    const bytes = this.journalBytes + update.byteLength
    const compact = sequence >= 128 || bytes >= 8 * 1024 * 1024
    this.ctx.storage.transactionSync(() => {
      if (compact) {
        const snapshot = Y.encodeStateAsUpdate(this.doc)
        this.sql.exec('DELETE FROM snapshot_chunks')
        for (let offset = 0; offset < snapshot.length; offset += chunkSize) {
          this.sql.exec('INSERT INTO snapshot_chunks (position, data) VALUES (?, ?)', offset / chunkSize, snapshot.slice(offset, offset + chunkSize))
        }
        this.sql.exec('DELETE FROM room_updates')
      } else {
        for (let offset = 0; offset < update.length; offset += chunkSize) {
          this.sql.exec('INSERT INTO room_updates (sequence, position, data) VALUES (?, ?, ?)', sequence, offset / chunkSize, update.slice(offset, offset + chunkSize))
        }
      }
    })
    this.sequence = compact ? 0 : sequence
    this.journalBytes = compact ? 0 : bytes
  }

  send(socket, message) {
    if (socket.deserializeAttachment()?.chunked) sendSocketMessage(message, frame => socket.send(frame))
    else socket.send(message)
  }

  receive(socket, message) {
    const frame = new Uint8Array(message)
    let entry = this.chunkReaders.get(socket)
    if (!entry && readSocketReceipt(frame) !== undefined && socket.deserializeAttachment()?.chunked) {
      socket.send(frame)
      return
    }
    if (!entry && !isSocketChunk(frame)) {
      receiveMessage(this.doc, this.presence, socket, frame, bytes => this.send(socket, bytes))
      return
    }
    const attachment = socket.deserializeAttachment()
    if (!attachment?.chunked || !attachment.canWrite) throw new Error('Chunked updates require edit access')
    const now = Date.now()
    for (const [peer, pending] of this.chunkReaders) {
      if (pending.expiresAt <= now) {
        this.chunkReaders.delete(peer)
        peer.close(1003, 'Collaboration chunks expired')
      }
    }
    if (socket.readyState !== WebSocket.OPEN) return
    entry = this.chunkReaders.get(socket)
    if (!entry) {
      if (this.chunkReaders.size >= 2) throw new Error('Too many concurrent chunked updates')
      entry = { reader: new SocketMessageReader(), expiresAt: now + 15000 }
      this.chunkReaders.set(socket, entry)
    }
    const complete = entry.reader.read(frame)
    if (!complete) {
      const pendingBytes = [...this.chunkReaders.values()].reduce((total, message) => total + message.reader.expectedBytes, 0)
      if (pendingBytes > maxSocketMessage) throw new Error('Too many pending collaboration bytes')
      return
    }
    this.chunkReaders.delete(socket)
    if (complete[0] !== 0) throw new Error('Only sync messages can be chunked')
    receiveMessage(this.doc, this.presence, socket, complete, bytes => this.send(socket, bytes))
  }

  broadcast(message) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) {
        if (this.closeExpired(socket)) continue
        try { this.send(socket, message) } catch { this.webSocketClose(socket) }
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/demo-images') && this.env.COLWORK_DEMO_IMAGES === '1') return handleDemoImage(this.sql, request)
    if (url.pathname === '/internal/export') {
      return Response.json(exportYjsSnapshot(this.doc, { room: url.searchParams.get('room') ?? undefined }), {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition': 'attachment; filename="colwork.snapshot.json"',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
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
    const isPrivate = url.pathname === '/internal/private-socket'
    const canWrite = !isPrivate || request.headers.get('x-colwork-can-edit') === 'true'
    server.serializeAttachment({
      delay: isPrivate ? 0 : Number(request.headers.get('x-colwork-delay')) || 0,
      expiresAt: isPrivate ? Number(request.headers.get('x-colwork-expires-at')) : undefined,
      canWrite, chunked: url.searchParams.get('colworkChunks') === '1', presence: [],
    })
    if (canWrite) server.send(syncRequest(this.doc))
    if (this.presence.states.size) server.send(awarenessMessage(this.presence, [...this.presence.states.keys()]))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket, message) {
    if (typeof message === 'string') { socket.close(1003, 'Expected binary sync'); return }
    if (message.byteLength > maxSocketFrame) { socket.close(1009, 'Message too large'); return }
    // Preserve per-socket ordering when test latency is enabled.
    const previous = this.queues.get(socket) ?? Promise.resolve()
    const current = previous.then(async () => {
      const delay = socket.deserializeAttachment()?.delay ?? 0
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (socket.readyState === WebSocket.OPEN && !this.closeExpired(socket)) this.receive(socket, message)
    }).catch(() => {
      this.chunkReaders.delete(socket)
      socket.close(1003, 'Invalid collaboration message')
    })
    this.queues.set(socket, current)
    await current
    if (this.queues.get(socket) === current) this.queues.delete(socket)
  }

  webSocketClose(socket) {
    this.chunkReaders.delete(socket)
    removePresence(this.presence, socket)
    // Complete the server half of the closing handshake for hibernating sockets.
    try { socket.close(1000, 'Connection closed') } catch {}
  }
  webSocketError(socket) {
    this.chunkReaders.delete(socket)
    removePresence(this.presence, socket)
    try { socket.close(1011, 'Connection error') } catch {}
  }

  closeExpired(socket) {
    const expiresAt = socket.deserializeAttachment()?.expiresAt
    if (expiresAt === undefined || Date.now() < expiresAt) return false
    try { socket.close(1008, 'Login expired') } catch {}
    return true
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return json({ status: 'ok', service: 'colwork-backend' })
    if (env.COLWORK_DEMO_IMAGES === '1' && (url.pathname === '/api/demo-images' || url.pathname.startsWith('/api/demo-images/'))) {
      if (request.method === 'POST' && (url.pathname !== '/api/demo-images' || request.headers.get('Origin') !== url.origin)) {
        return json({ error: 'Origin denied' }, 403)
      }
      return env.ROOMS.getByName('local-demo-images').fetch(request)
    }
    const documentRoute = url.pathname.match(/^\/api\/documents\/([^/]+)\/(view-policy|export)$/)
    const privateSocket = url.pathname.match(/^\/rooms\/private\/([^/]+)$/)
    if (documentRoute || privateSocket) {
      const room = (documentRoute ?? privateSocket)[1]
      if (!documentIdPattern.test(room)) return privateJson({ error: 'Invalid document id' }, 400)
      if (request.method !== 'GET') return privateJson({ error: 'Method not allowed' }, 405)
      if (privateSocket) {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return privateJson({ error: 'WebSocket upgrade required' }, 426)
        if (request.headers.get('Origin') !== url.origin) return privateJson({ error: 'Origin denied' }, 403)
      }
      const access = await documentAccess(request, env, room)
      if (access instanceof Response) return access
      if (documentRoute?.[2] === 'view-policy') {
        return privateJson({ displayName: access.displayName, canEdit: access.canEdit, viewPolicy: access.viewPolicy })
      }
      const storage = env.ROOMS.getByName(`private-room:${room}`)
      if (documentRoute) {
        if (!access.viewPolicy.allowExport) return privateJson({ error: 'Export denied' }, 403)
        return storage.fetch(new URL(`/internal/export?room=${encodeURIComponent(room)}`, url))
      }
      const headers = new Headers(request.headers)
      headers.delete('Cookie')
      headers.set('x-colwork-can-edit', String(access.canEdit))
      headers.set('x-colwork-expires-at', String(access.expiresAt))
      const destination = new URL('/internal/private-socket', url)
      destination.search = url.search
      return storage.fetch(new Request(destination, { headers }))
    }
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
