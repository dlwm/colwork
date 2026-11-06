/** Reject lone UTF-16 surrogates while preserving valid pairs such as emoji. */
export function isUnicodeString(value: string) {
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point >= 0xd800 && point <= 0xdfff) return false
  }
  return true
}

/** Yjs transports UTF-8. Normalize an input before its local value enters the CRDT. */
export function normalizeCellText(value: string) {
  return Array.from(value, character => {
    const point = character.codePointAt(0)!
    return point >= 0xd800 && point <= 0xdfff ? '\ufffd' : character
  }).join('')
}
