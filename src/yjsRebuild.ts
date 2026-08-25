import * as Y from 'yjs'
import { base64ToBytes, bytesToBase64, type YjsArchiveFile, type YjsSnapshotFile, type YjsUpdateLogFile, type YjsUpdateRecord } from './yjsArchive'

type InputFile = YjsSnapshotFile | YjsUpdateLogFile | YjsArchiveFile

function parseInput(value: string | undefined) {
  if (!value?.trim()) return undefined
  return JSON.parse(value) as InputFile
}

function getSnapshot(value: InputFile | undefined) {
  if (!value || value.format === 'colwork.update-log') return undefined
  return value.format === 'colwork.archive' ? value.snapshot : value
}

function getUpdates(value: InputFile | undefined): YjsUpdateRecord[] {
  if (!value || value.format === 'colwork.snapshot') return []
  return value.updates ?? []
}

export function rebuildYjsSnapshot(snapshotText?: string, updateLogText?: string): YjsSnapshotFile {
  const snapshotInput = parseInput(snapshotText)
  const updateInput = parseInput(updateLogText)
  const snapshot = getSnapshot(snapshotInput)
  const updates = [...getUpdates(snapshotInput), ...getUpdates(updateInput)]
  const doc = new Y.Doc()
  if (snapshot?.snapshot) Y.applyUpdate(doc, base64ToBytes(snapshot.snapshot))

  const snapshotSequence = Number(snapshot?.sequence ?? 0)
  const seenSequences = new Set<number>()
  const seenUpdates = new Set<string>()
  let sequence = snapshotSequence
  for (const record of updates.sort((left, right) => Number(left.seq) - Number(right.seq))) {
    const current = Number(record.seq)
    if (!Number.isInteger(current) || typeof record.update !== 'string') continue
    if (current <= snapshotSequence || seenSequences.has(current) || seenUpdates.has(record.update)) continue
    Y.applyUpdate(doc, base64ToBytes(record.update))
    seenSequences.add(current)
    seenUpdates.add(record.update)
    sequence = Math.max(sequence, current)
  }

  return {
    format: 'colwork.snapshot',
    version: 1,
    room: snapshot?.room,
    sequence,
    snapshot: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    stateVector: bytesToBase64(Y.encodeStateVector(doc)),
  }
}
