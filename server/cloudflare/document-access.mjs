const audience = 'colwork'
const maxSessionSeconds = 900
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export const documentIdPattern = /^[A-Za-z0-9_-]{1,128}$/

function decodeBase64Url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new TypeError('Invalid base64url')
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
}

export function privateJson(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export async function documentAccess(request, env, documentId) {
  const secret = env.COLWORK_SESSION_SECRET
  if (typeof secret !== 'string' || encoder.encode(secret).length < 32) {
    return privateJson({ error: 'Document authentication is not configured' }, 503)
  }
  const cookies = (request.headers.get('Cookie') ?? '').split(';').map(cookie => cookie.trim())
    .filter(cookie => cookie.startsWith('colwork_session='))
  const unauthorized = () => privateJson({ error: 'Valid login required' }, 401)
  if (cookies.length !== 1) return unauthorized()
  const token = cookies[0].slice('colwork_session='.length)
  if (token.length > 3800) return unauthorized()
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return unauthorized()
  let session
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const valid = await crypto.subtle.verify('HMAC', key, decodeBase64Url(parts[2]), encoder.encode(`v1.${parts[1]}`))
    if (!valid) return unauthorized()
    session = JSON.parse(decoder.decode(decodeBase64Url(parts[1])))
  } catch {
    return unauthorized()
  }
  const now = Math.floor(Date.now() / 1000)
  if (session?.aud !== audience || typeof session.sub !== 'string' || !session.sub.trim() ||
    session.sub.length > 128 || !Number.isSafeInteger(session.exp) || session.exp <= now ||
    session.exp > now + maxSessionSeconds || !Array.isArray(session.documents)) return unauthorized()
  const grant = session.documents.find(document => document?.id === documentId)
  if (!grant) return privateJson({ error: 'Document access denied' }, 403)
  const displayName = typeof session.name === 'string' && session.name.trim() ? session.name.trim().slice(0, 80) : session.sub
  return {
    displayName,
    expiresAt: session.exp * 1000,
    canEdit: grant.canEdit === true,
    viewPolicy: {
      allowExport: grant.allowExport === true,
      watermark: {
        viewerText: grant.viewerWatermark === true ? displayName : undefined,
        fixedText: typeof grant.fixedWatermark === 'string' ? grant.fixedWatermark.slice(0, 160) : undefined,
      },
    },
  }
}
