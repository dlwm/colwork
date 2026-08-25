import http from 'node:http'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { createServer as createViteServer } from 'vite'
const require = createRequire(import.meta.url)
const { setupWSConnection } = require('../node_modules/y-websocket/bin/utils.cjs')

const port = Number(process.env.PORT ?? 4444)
const heartbeatMs = 15000
const topics = new Map()
const wss = new WebSocketServer({ noServer: true })
const yWss = new WebSocketServer({ noServer: true })
const testMode = process.argv.includes('--mode=test') || process.argv.includes('--mode') && process.argv[process.argv.indexOf('--mode') + 1] === 'test'
const webrtcMode = process.argv.includes('--transport=webrtc') || process.argv.includes('--transport') && process.argv[process.argv.indexOf('--transport') + 1] === 'webrtc'
const websocketMode = !webrtcMode
let yHttpServer
let yPort = 1234
let viteServer
const users = new Map()

const httpServer = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' })
    response.end()
    return
  }
  if (request.method === 'POST' && request.url === '/api/users') {
    let body = ''
    for await (const chunk of request) body += chunk
    try {
      const user = JSON.parse(body)
      const id = String(user.id ?? '')
      if (!id) throw new Error('missing user id')
      users.set(id, { id, nickname: String(user.nickname ?? ''), color: String(user.color ?? ''), delay: Math.max(0, Math.min(30000, Number(user.delay) || 0)), updatedAt: Date.now() })
      response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      response.end(JSON.stringify(users.get(id)))
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      response.end(JSON.stringify({ error: String(error) }))
    }
    return
  }
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(request.url === '/health' ? 'ok' : 'colwork signaling server')
})

yWss.on('connection', (connection, request) => {
  const userId = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('userId') ?? ''
  const emit = connection.emit.bind(connection)
  connection.emit = (event, ...args) => {
    if (event !== 'message') return emit(event, ...args)
    const delay = users.get(userId)?.delay ?? 0
    if (!delay) return emit(event, ...args)
    setTimeout(() => emit(event, ...args), delay)
    return true
  }
  setupWSConnection(connection, request)
})

yHttpServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('colwork y-websocket server')
})
yHttpServer.on('upgrade', (request, socket, head) => {
  yWss.handleUpgrade(request, socket, head, (connection) => yWss.emit('connection', connection, request))
})

function send(connection, message) {
  if (connection.readyState === 1) connection.send(JSON.stringify(message))
}

function removeFromTopics(connection, subscribedTopics) {
  subscribedTopics.forEach((topicName) => {
    const subscribers = topics.get(topicName)
    subscribers?.delete(connection)
    if (subscribers?.size === 0) topics.delete(topicName)
  })
}

wss.on('connection', (connection) => {
  const subscribedTopics = new Set()
  let alive = true

  const heartbeat = setInterval(() => {
    if (!alive) {
      connection.terminate()
      return
    }
    alive = false
    connection.ping()
  }, heartbeatMs)

  connection.on('pong', () => { alive = true })
  connection.on('error', (error) => console.error(`[signal:error] ${error.message}`))
  connection.on('close', () => {
    clearInterval(heartbeat)
    removeFromTopics(connection, subscribedTopics)
  })
  connection.on('message', (raw) => {
    const message = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    if (!message?.type) return

    if (message.type === 'subscribe') {
      for (const topicName of message.topics ?? []) {
        if (typeof topicName !== 'string') continue
        if (!topics.has(topicName)) topics.set(topicName, new Set())
        topics.get(topicName).add(connection)
        subscribedTopics.add(topicName)
      }
      return
    }

    if (message.type === 'unsubscribe') {
      for (const topicName of message.topics ?? []) {
        topics.get(topicName)?.delete(connection)
        subscribedTopics.delete(topicName)
      }
      return
    }

    if (message.type === 'publish' && message.topic) {
      console.log(`[signal:publish] topic=${message.topic} clients=${topics.get(message.topic)?.size ?? 0}`)
      for (const subscriber of topics.get(message.topic) ?? []) {
        send(subscriber, { ...message, clients: topics.get(message.topic).size })
      }
      return
    }

    if (message.type === 'ping') send(connection, { type: 'pong' })
  })
})

httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (connection) => {
    wss.emit('connection', connection, request)
  })
})

httpServer.listen(port, '127.0.0.1', () => {
  console.log(`Colwork WebRTC signaling: ws://127.0.0.1:${port}`)
  console.log(`Health: http://127.0.0.1:${port}/health`)
})

if (testMode) {
  if (websocketMode) {
    yHttpServer.listen(yPort, '127.0.0.1', () => console.log(`Yjs WebSocket: ws://127.0.0.1:${yPort}`))
  }
  viteServer = await createViteServer({
    server: { host: '127.0.0.1', port: 5173 },
    define: { __COLWORK_TRANSPORT__: JSON.stringify(websocketMode ? 'websocket' : 'webrtc') },
    appType: 'mpa',
  })
  await viteServer.listen()
  const query = websocketMode ? '?transport=websocket' : '?transport=webrtc'
      console.log(`Vue test page:   http://127.0.0.1:5173/test/vue.html${query}`)
      console.log(`React test page: http://127.0.0.1:5173/test/react.html${query}`)
      console.log('Yjs tools page:  http://127.0.0.1:5173/test/index.html')
}

const shutdown = async () => {
  await viteServer?.close()
  await new Promise((resolve) => {
    wss.close(() => resolve())
    httpServer.close(() => resolve())
  })
  if (websocketMode) {
    await new Promise((resolve) => yWss.close(() => resolve()))
    await new Promise((resolve) => yHttpServer.close(() => resolve()))
  }
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
