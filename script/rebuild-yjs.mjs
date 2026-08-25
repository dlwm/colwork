#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import * as Y from 'yjs'

function usage() {
  console.error('Usage: node script/rebuild-yjs.mjs [--input archive.json] [--snapshot snapshot.json] [--updates update-log.json] --output latest-snapshot.json')
  process.exit(1)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) usage()
    args[key] = next
    index += 1
  }
  if (!args.output || (!args.input && !args.snapshot && !args.updates)) usage()
  return args
}

async function readJson(fileName) {
  return JSON.parse(await readFile(fileName, 'utf8'))
}

function decode(value) {
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

function encode(value) {
  return Buffer.from(value).toString('base64')
}

function getSnapshot(file) {
  if (!file) return undefined
  if (file.format === 'colwork.snapshot') return file
  if (file.format === 'colwork.archive') return file.snapshot
  throw new Error('Unsupported snapshot format')
}

function getUpdates(file) {
  if (!file) return []
  if (file.format === 'colwork.update-log') return file.updates ?? []
  if (file.format === 'colwork.archive') return file.updates ?? []
  throw new Error('Unsupported update log format')
}

const args = parseArgs(process.argv.slice(2))
const inputFile = args.input ? await readJson(args.input) : undefined
const snapshotFile = args.snapshot ? await readJson(args.snapshot) : undefined
const snapshot = getSnapshot(inputFile ?? snapshotFile)
const updates = [...getUpdates(inputFile), ...getUpdates(snapshotFile), ...getUpdates(args.updates ? await readJson(args.updates) : undefined)]
const doc = new Y.Doc()

if (snapshot?.snapshot) Y.applyUpdate(doc, decode(snapshot.snapshot))

const snapshotSequence = Number(snapshot?.sequence ?? 0)
const seenSequences = new Set()
const seenUpdates = new Set()
let latestSequence = snapshotSequence
for (const record of [...updates].sort((left, right) => Number(left.seq) - Number(right.seq))) {
  const sequence = Number(record.seq)
  if (!Number.isInteger(sequence) || typeof record.update !== 'string') continue
  if (sequence <= snapshotSequence || seenSequences.has(sequence) || seenUpdates.has(record.update)) continue
  Y.applyUpdate(doc, decode(record.update))
  seenSequences.add(sequence)
  seenUpdates.add(record.update)
  latestSequence = Math.max(latestSequence, sequence)
}

const output = {
  format: 'colwork.snapshot',
  version: 1,
  room: snapshot?.room,
  sequence: latestSequence,
  snapshot: encode(Y.encodeStateAsUpdate(doc)),
  stateVector: encode(Y.encodeStateVector(doc)),
}
await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
console.log(`Rebuilt ${args.output}: sequence=${latestSequence}, appliedUpdates=${seenSequences.size}`)
