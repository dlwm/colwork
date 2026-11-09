import type * as Y from 'yjs'
import { cellKey, type CellPosition } from './range'
import { getSheetMaps } from './model-validation'
import { SheetCoordinates } from './sheetCoordinates'
import { listWorkbookSheets, MAIN_SHEET_ID } from './workbookModel'
import { imageLabel, readCellImage } from './cellImage'

const marker = '\u0000colwork:formula:'
const reference = /^(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})(?![\p{L}\p{N}_.(])/u
type BoundRef = { sheet: string; key: string; qualified: boolean; rowAbsolute: boolean; columnAbsolute: boolean }
type FormulaPart = string | BoundRef
type Scalar = string | number | boolean | null
type Value = Scalar | Scalar[]
type Term = () => Value
type Token = { kind: 'value'; value: Scalar } | { kind: 'ref'; ref: BoundRef } | { kind: 'name' | 'op'; text: string }
const excelErrors = /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|NUM!|N\/A|NULL!|CYCLE!)/
const numericLiteral = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i

class FormulaError extends Error {}
function fail(code: string): never { throw new FormulaError(code) }

export function excelColumn(index: number) {
  let text = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + (n - 1) % 26) + text
  return text
}

function decodeFormula(raw: string): FormulaPart[] | undefined {
  if (!raw.startsWith(marker)) return undefined
  try {
    const value = JSON.parse(raw.slice(marker.length))
    return Array.isArray(value) && value.length <= 2048 && value.every(part => typeof part === 'string' || (
      part && typeof part.sheet === 'string' && typeof part.key === 'string' && typeof part.qualified === 'boolean' &&
      typeof part.rowAbsolute === 'boolean' && typeof part.columnAbsolute === 'boolean'
    )) ? value : undefined
  } catch { return undefined }
}

export class FormulaBook {
  private readonly sheets = new Map<string, { coordinates: SheetCoordinates; cells: Y.Map<string> }>()
  private readonly memo = new Map<string, Scalar | FormulaError>()
  private readonly active = new Set<string>()
  private names?: Map<string, string>
  constructor(private readonly document: Y.Doc) {}

  reset() {
    this.sheets.clear()
    this.memo.clear()
    this.names = undefined
  }

  private get sheetNames() {
    return this.names ??= new Map(listWorkbookSheets(this.document).map(({ id, name }) => [id, name]))
  }

  private sheet(id: string) {
    let result = this.sheets.get(id)
    if (!result) {
      result = { coordinates: new SheetCoordinates(this.document, id), cells: getSheetMaps(this.document, id).cells }
      this.sheets.set(id, result)
    }
    return result
  }

  private bind(source: string, sheetId: string, aliases?: ReadonlyMap<string, string>): FormulaPart[] {
    const parts: FormulaPart[] = []
    let text = ''
    let previous: BoundRef | undefined
    for (let offset = 0; offset < source.length;) {
      const rest = source.slice(offset)
      const quoted = /^"(?:[^"]|"")*"/.exec(rest)?.[0]
      const literalToken = quoted ?? numericLiteral.exec(rest)?.[0] ?? excelErrors.exec(rest)?.[0]
      const match = !literalToken && reference.exec(rest)
      if (match) {
        const [, quotedSheet, plainSheet, columnAbsolute, letters, rowAbsolute, digits] = match
        const label = quotedSheet?.replace(/''/g, "'") ?? plainSheet
        let sheet = sheetId
        if (label !== undefined) {
          const normalized = label.toLowerCase()
          sheet = aliases?.get(normalized) ?? [...this.sheetNames].find(([, name]) => name.toLowerCase() === normalized)?.[0] ?? ''
        } else if (previous && /^\s*:\s*$/.test(text)) sheet = previous.sheet
        const column = [...letters.toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1
        const row = Number(digits) - 1
        const key = sheet && row < 1048576 && column < 16384 ? this.sheet(sheet).coordinates.cellId(cellKey({ row, column })) ?? '' : ''
        if (text) parts.push(text)
        previous = { sheet, key, qualified: label !== undefined, rowAbsolute: !!rowAbsolute, columnAbsolute: !!columnAbsolute }
        parts.push(previous)
        text = ''
        offset += match[0].length
      } else {
        const literal = literalToken ?? /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(rest)?.[0] ?? rest[0]
        text += literal
        offset += literal.length
      }
    }
    if (text) parts.push(text)
    return parts
  }

  store(value: string, sheet = MAIN_SHEET_ID, aliases?: ReadonlyMap<string, string>) {
    if (!value.startsWith('=') || value.length > 8192) return value
    const parts = this.bind(value.slice(1), sheet, aliases)
    return parts.length > 2048 ? value : marker + JSON.stringify(parts)
  }

  source(value: string) {
    const parts = decodeFormula(value)
    if (!parts) return value.startsWith(marker) ? '=#VALUE!' : value
    return '=' + parts.map(part => {
      if (typeof part === 'string') return part
      const name = this.sheetNames.get(part.sheet)
      const position = name && this.sheet(part.sheet).coordinates.cellPosition(part.key)
      if (!position) return '#REF!'
      const qualifier = part.qualified ? `'${name.replace(/'/g, "''")}'!` : ''
      return qualifier + (part.columnAbsolute ? '$' : '') + excelColumn(position.column)
        + (part.rowAbsolute ? '$' : '') + (position.row + 1)
    }).join('')
  }

  display(sheet: string, id: string, raw: string) {
    if (raw.startsWith("'=")) return raw.slice(1)
    return raw.startsWith(marker) || raw.startsWith('=') ? formatFormulaValue(this.value(sheet, id)) : raw
  }

  value(sheet: string, key: string): Scalar {
    try { return this.calculate(sheet, key) } catch (error) { return error instanceof FormulaError ? error.message : '#VALUE!' }
  }

  private calculate(sheet: string, key: string): Scalar {
    const referenceKey = `${sheet}/${key}`
    if (this.memo.has(referenceKey)) {
      const value = this.memo.get(referenceKey)!
      if (value instanceof FormulaError) throw value
      return value
    }
    if (this.active.has(referenceKey)) fail('#CYCLE!')
    if (this.active.size >= 128) fail('#NUM!')
    if (!this.sheetNames.has(sheet) || !this.sheet(sheet).coordinates.cellPosition(key)) fail('#REF!')
    const raw = this.sheet(sheet).cells.get(key)
    if (raw === undefined || raw === '') return null
    const image = readCellImage(raw)
    if (image) return imageLabel(image)
    if (!raw.startsWith(marker) && !raw.startsWith('=')) return parseScalar(raw)
    this.active.add(referenceKey)
    try {
      if (raw.length > 131072) fail('#NUM!')
      const parts = decodeFormula(raw) ?? (raw.startsWith('=') ? this.bind(raw.slice(1), sheet) : fail('#VALUE!'))
      const value = scalar(this.evaluate(parts))
      if (typeof value === 'number' && !Number.isFinite(value)) fail('#NUM!')
      this.memo.set(referenceKey, value)
      return value
    } catch (error) {
      const value = error instanceof FormulaError ? error : new FormulaError('#VALUE!')
      this.memo.set(referenceKey, value)
      throw value
    } finally { this.active.delete(referenceKey) }
  }

  private range(start: BoundRef, end: BoundRef): Scalar[] {
    if (start.sheet !== end.sheet || !this.sheetNames.has(start.sheet)) fail('#REF!')
    const { coordinates } = this.sheet(start.sheet)
    const a = coordinates.cellPosition(start.key)
    const b = coordinates.cellPosition(end.key)
    if (!a || !b) fail('#REF!')
    const top = Math.min(a.row, b.row), bottom = Math.max(a.row, b.row)
    const left = Math.min(a.column, b.column), right = Math.max(a.column, b.column)
    if ((bottom - top + 1) * (right - left + 1) > 100000) fail('#NUM!')
    const values: Scalar[] = []
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) values.push(this.calculate(start.sheet, coordinates.cellId(cellKey({ row, column }))!))
    }
    return values
  }

  private evaluate(parts: FormulaPart[]): Value {
    const tokens = tokenize(parts)
    let index = 0
    const take = () => tokens[index++]
    const nextOp = (operator: string) => {
      const token = tokens[index]
      return token?.kind === 'op' && token.text === operator
    }
    const accept = (operator: string) => nextOp(operator) && !!take()
    const required = (operator: string) => { if (!accept(operator)) fail('#VALUE!') }
    const precedence: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 }
    const expression = (minimum = 0, depth = 0): Term => {
      if (depth > 128) fail('#NUM!')
      const token = take()
      if (!token) fail('#VALUE!')
      let term: Term
      if (token.kind === 'value') term = () => token.value
      else if (token.kind === 'ref') {
        if (accept(':')) {
          const end = take()
          if (end?.kind !== 'ref') fail('#REF!')
          term = () => this.range(token.ref, end.ref)
        } else term = () => this.calculate(token.ref.sheet, token.ref.key)
      } else if (token.kind === 'name') {
        if (token.text.startsWith('#')) term = () => fail(token.text)
        else if (!nextOp('(') && ['TRUE', 'FALSE'].includes(token.text)) term = () => token.text === 'TRUE'
        else {
          required('(')
          const args: Term[] = []
          if (!nextOp(')')) { do { args.push(expression(0, depth + 1)) } while (accept(',') || accept(';')) }
          required(')')
          term = () => call(token.text, args)
        }
      } else if (token.text === '(') {
        term = expression(0, depth + 1)
        required(')')
      } else if (token.text === '+' || token.text === '-') {
        const right = expression(6, depth + 1)
        term = () => (token.text === '-' ? -1 : 1) * numeric(right())
      } else fail('#VALUE!')
      while (accept('%')) {
        const left = term
        term = () => numeric(left()) / 100
      }
      for (;;) {
        const op = tokens[index]
        if (op?.kind !== 'op' || !precedence[op.text] || precedence[op.text] < minimum) return term
        take()
        const left = term
        const right = expression(precedence[op.text] + Number(op.text !== '^'), depth + 1)
        term = () => binary(op.text, left(), right())
      }
    }
    const term = expression()
    if (index !== tokens.length) fail('#VALUE!')
    return term()
  }
}

function tokenize(parts: FormulaPart[]) {
  const tokens: Token[] = []
  for (const part of parts) {
    if (tokens.length >= 2048) fail('#NUM!')
    if (typeof part !== 'string') { tokens.push({ kind: 'ref', ref: part }); continue }
    let text = part.trimStart()
    while (text) {
      if (tokens.length >= 2048) fail('#NUM!')
      const quoted = /^"((?:[^"]|"")*)"/.exec(text)
      const num = numericLiteral.exec(text)?.[0]
      const name = excelErrors.exec(text)?.[0] ?? /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(text)?.[0]
      const op = /^(?:<=|>=|<>|[+\-*/^&=<>%,;():])/.exec(text)?.[0]
      if (quoted) { tokens.push({ kind: 'value', value: quoted[1].replace(/""/g, '"') }); text = text.slice(quoted[0].length) }
      else if (num) { tokens.push({ kind: 'value', value: Number(num) }); text = text.slice(num.length) }
      else if (name) { tokens.push({ kind: 'name', text: name.toUpperCase() }); text = text.slice(name.length) }
      else if (op) { tokens.push({ kind: 'op', text: op }); text = text.slice(op.length) }
      else fail('#VALUE!')
      text = text.trimStart()
    }
  }
  return tokens
}

function parseScalar(value: string): Scalar {
  if (value.startsWith("'=")) return value.slice(1)
  if (/^true$/i.test(value)) return true
  if (/^false$/i.test(value)) return false
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))) return Number(value)
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%$/.test(value)) return Number(value.slice(0, -1)) / 100
  return value
}
function scalar(value: Value): Scalar { return Array.isArray(value) ? value[0] ?? null : value }
function numeric(value: Value) {
  const raw = scalar(value)
  if (raw !== null && typeof raw === 'string' && !raw.trim()) return 0
  const number = Number(raw)
  return Number.isFinite(number) ? number : fail('#VALUE!')
}
function binary(operator: string, left: Value, right: Value): Scalar {
  const a = scalar(left), b = scalar(right)
  if (operator === '&') return String(a ?? '') + String(b ?? '')
  if (['=', '<>', '<', '>', '<=', '>='].includes(operator)) {
    const lhs = typeof a === 'string' ? a.toLowerCase() : a ?? 0
    const rhs = typeof b === 'string' ? b.toLowerCase() : b ?? 0
    if (operator === '=') return lhs === rhs
    if (operator === '<>') return lhs !== rhs
    if (operator === '<') return lhs < rhs
    if (operator === '>') return lhs > rhs
    return operator === '<=' ? lhs <= rhs : lhs >= rhs
  }
  const x = numeric(left), y = numeric(right)
  if (operator === '+') return x + y
  if (operator === '-') return x - y
  if (operator === '*') return x * y
  if (operator === '/') return y === 0 ? fail('#DIV/0!') : x / y
  return x ** y
}
function call(name: string, args: Term[]): Scalar {
  if (name === 'IF') {
    if (args.length < 2 || args.length > 3) fail('#VALUE!')
    return scalar(scalar(args[0]()) ? args[1]() : args[2]?.() ?? false)
  }
  if (name === 'IFERROR') {
    if (args.length !== 2) fail('#VALUE!')
    try { return scalar(args[0]()) } catch (error) {
      if (error instanceof FormulaError && error.message !== '#CYCLE!') return scalar(args[1]())
      throw error
    }
  }
  const values = args.flatMap(arg => arg())
  const numbers = values.filter((value): value is number => typeof value === 'number')
  const sum = () => numbers.reduce((total, value) => total + value, 0)
  switch (name) {
    case 'SUM': return sum()
    case 'AVERAGE': return numbers.length ? sum() / numbers.length : fail('#DIV/0!')
    case 'MIN': return numbers.reduce((a, b) => Math.min(a, b), numbers[0] ?? 0)
    case 'MAX': return numbers.reduce((a, b) => Math.max(a, b), numbers[0] ?? 0)
    case 'COUNT': return numbers.length
    case 'COUNTA': return values.filter(value => value !== null).length
    case 'ABS': return Math.abs(numeric(values[0] ?? null))
    case 'MOD': {
      const a = numeric(values[0] ?? null), b = numeric(values[1] ?? null)
      return b === 0 ? fail('#DIV/0!') : a - b * Math.floor(a / b)
    }
    case 'POWER': return numeric(values[0] ?? null) ** numeric(values[1] ?? null)
    case 'ROUND': {
      const precision = Math.trunc(numeric(values[1] ?? null))
      if (Math.abs(precision) > 100) fail('#NUM!')
      const factor = 10 ** precision
      const number = numeric(values[0] ?? null)
      return Math.sign(number) * Math.round(Math.abs(number) * factor + Number.EPSILON) / factor
    }
    case 'AND': return values.every(Boolean)
    case 'OR': return values.some(Boolean)
    case 'NOT': return !values[0]
    case 'TRUE': return true
    case 'FALSE': return false
    case 'LEN': return String(values[0] ?? '').length
    case 'LOWER': return String(values[0] ?? '').toLowerCase()
    case 'UPPER': return String(values[0] ?? '').toUpperCase()
    case 'TRIM': return String(values[0] ?? '').trim().replace(/ +/g, ' ')
    case 'CONCAT':
    case 'CONCATENATE': return values.join('')
    default: return fail('#NAME?')
  }
}

export function formatFormulaValue(value: Scalar): string {
  return typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value ?? '')
}
