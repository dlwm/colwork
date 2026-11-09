import type { ColworkImageOptions } from '../src/options'

const api = '/api/demo-images'
export const demoImages: ColworkImageOptions | undefined = ['127.0.0.1', 'localhost'].includes(location.hostname) && location.port === '8787' ? {
  async upload(file) {
    const response = await fetch(api, { method: 'POST', body: file })
    const result = await response.json().catch(() => null)
    if (!response.ok) throw new Error(result?.error ?? '本地图片上传服务不可用')
    return { id: result.id, alt: file.name.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 160) }
  },
  resolveUrl: id => /^[0-9a-f-]{36}$/u.test(id) ? `${api}/${id}` : undefined,
} : undefined
