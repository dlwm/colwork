declare const __COLWORK_CLOUDFLARE__: boolean
export const cloudflareDeployment = typeof __COLWORK_CLOUDFLARE__ !== 'undefined' && __COLWORK_CLOUDFLARE__
export type UserSettings = { id: string; nickname: string; color: string; delay: number }

const storageKey = 'colwork-user-settings'
const moods = ['开心', '困倦', '兴奋', '平静', '害羞', '勇敢']
const fruits = ['苹果', '香蕉', '西瓜', '葡萄', '桃子', '橙子']

function randomDefault(): UserSettings {
  const nickname = `${moods[Math.floor(Math.random() * moods.length)]}${fruits[Math.floor(Math.random() * fruits.length)]}`
  const color = `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`
  return { id: crypto.randomUUID(), nickname, color, delay: 0 }
}

export function loadUserSettings(scope = 'default'): UserSettings {
  const key = `${storageKey}-${scope}`
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (saved?.id && saved?.nickname && saved?.color) return { id: saved.id, nickname: saved.nickname, color: saved.color, delay: Number(saved.delay) || 0 }
    return randomDefault()
  } catch {
    return randomDefault()
  }
}

export async function saveUserSettings(settings: UserSettings, scope = 'default') {
  localStorage.setItem(`${storageKey}-${scope}`, JSON.stringify(settings))
  const response = await fetch(cloudflareDeployment ? '/api/users' : 'http://127.0.0.1:4444/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) })
  if (!response.ok) throw new Error('用户设置保存失败')
}

export function websocketUrl(settings: UserSettings) {
  if (cloudflareDeployment) return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rooms?userId=${encodeURIComponent(settings.id)}`
  return `ws://127.0.0.1:1234?userId=${encodeURIComponent(settings.id)}`
}

export function collaborationTransport() {
  return !cloudflareDeployment && new URLSearchParams(location.search).get('transport') === 'webrtc' ? 'webrtc' : 'websocket'
}
