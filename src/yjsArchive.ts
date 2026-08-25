export type YjsUpdateRecord = {
  seq: number
  update: string
  timestamp: number
}

export type YjsSnapshotFile = {
  format: 'colwork.snapshot'
  version: 1
  room?: string
  sequence: number
  snapshot: string
  stateVector: string
}

export type YjsUpdateLogFile = {
  format: 'colwork.update-log'
  version: 1
  room?: string
  updates: YjsUpdateRecord[]
}

export type YjsArchiveFile = {
  format: 'colwork.archive'
  version: 1
  room?: string
  snapshot?: YjsSnapshotFile
  updates: YjsUpdateRecord[]
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function base64ToBytes(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
