/** Versioned password verifier. Never stores the password or encrypts cell data. */
type PasswordLock = {
  version: 1
  algorithm: 'PBKDF2-SHA-256'
  iterations: 600000
  salt: string
  verifier: string
}
const iterations = 600000
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

async function derive(password: string, salt: Uint8Array<ArrayBuffer>) {
  if (!globalThis.crypto?.subtle) throw new Error('密码锁定需要 HTTPS 或 localhost 环境')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}

export async function createPasswordLock(password: string): Promise<string> {
  if (!password.length) throw new Error('密码不能为空')
  if (!globalThis.crypto?.subtle) throw new Error('密码锁定需要 HTTPS 或 localhost 环境')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const record: PasswordLock = {
    version: 1, algorithm: 'PBKDF2-SHA-256', iterations,
    salt: hex(salt), verifier: hex(await derive(password, salt)),
  }
  return JSON.stringify(record)
}

export async function verifyPasswordLock(record: string, password: string): Promise<boolean> {
  let value: PasswordLock
  try { value = JSON.parse(record) } catch { throw new Error('锁定数据无效，无法解锁') }
  if (!value || value.version !== 1 || value.algorithm !== 'PBKDF2-SHA-256' || value.iterations !== iterations
    || typeof value.salt !== 'string' || !/^[0-9a-f]{32}$/.test(value.salt)
    || typeof value.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(value.verifier)) {
    throw new Error('锁定数据无效或版本不受支持，无法解锁')
  }
  const salt = Uint8Array.from(value.salt.match(/../g)!, part => parseInt(part, 16))
  const actual = hex(await derive(password, salt))
  let difference = 0
  for (let index = 0; index < actual.length; index += 1) difference |= actual.charCodeAt(index) ^ value.verifier.charCodeAt(index)
  return difference === 0
}
