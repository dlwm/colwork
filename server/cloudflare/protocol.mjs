import * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import * as awareness from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export function syncRequest(doc) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  sync.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

export function syncUpdate(update) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  sync.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

export function awarenessMessage(state, ids) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint8Array(encoder, awareness.encodeAwarenessUpdate(state, ids))
  return encoding.toUint8Array(encoder)
}

// The server has no local presence and no polling timer. Presence is restored
// from socket attachments after hibernation and removed on socket close.
export function createPresence(clientID, broadcast) {
  const state = {
    clientID, states: new Map(), meta: new Map(),
    getLocalState: () => null,
    getStates() { return this.states },
    emit(event, [change]) {
      if (event === 'update') broadcast(awarenessMessage(this, [...change.added, ...change.updated, ...change.removed]))
    },
  }
  return state
}

export function receiveMessage(doc, state, socket, message) {
  if (typeof message === 'string') throw new Error('Expected binary Yjs protocol')
  const decoder = decoding.createDecoder(new Uint8Array(message))
  const type = decoding.readVarUint(decoder)
  if (type === 0) {
    const response = encoding.createEncoder()
    encoding.writeVarUint(response, 0)
    sync.readSyncMessage(decoder, response, doc, socket)
    if (encoding.length(response) > 1) socket.send(encoding.toUint8Array(response))
  } else if (type === 1) {
    const update = decoding.readVarUint8Array(decoder)
    const reader = decoding.createDecoder(update)
    const attachment = socket.deserializeAttachment()
    const entries = new Map((attachment.presence ?? []).map(entry => [entry.id, entry]))
    const count = decoding.readVarUint(reader)
    if (count > 16) throw new Error('Too many awareness clients')
    for (let index = 0; index < count; index++) {
      const id = decoding.readVarUint(reader)
      const clock = decoding.readVarUint(reader)
      const value = JSON.parse(decoding.readVarString(reader))
      const previous = entries.get(id)
      // y-websocket echoes remote presence. A socket only owns the clients it
      // introduced, otherwise closing one peer would remove everyone it echoed.
      const introducesClient = value !== null && !state.states.has(id) && (!state.meta.has(id) || clock > state.meta.get(id).clock)
      if ((previous || introducesClient) && (!previous || clock >= previous.clock)) entries.set(id, { id, clock, value })
    }
    const next = { ...attachment, presence: [...entries.values()] }
    if (new TextEncoder().encode(JSON.stringify(next)).length > 1900) throw new Error('Awareness state is too large')
    socket.serializeAttachment(next)
    awareness.applyAwarenessUpdate(state, update, socket)
  } else if (type === 3) {
    socket.send(awarenessMessage(state, [...state.states.keys()]))
  } else throw new Error('Unknown Yjs protocol message')
}

export function removePresence(state, socket) {
  const ids = (socket.deserializeAttachment()?.presence ?? []).map(entry => entry.id)
  awareness.removeAwarenessStates(state, ids, socket)
}

export { Y }
