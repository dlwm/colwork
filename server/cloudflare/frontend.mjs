export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname
    if (path === '/health' || path.startsWith('/api/') || path.startsWith('/rooms/')) return env.BACKEND.fetch(request)
    return env.ASSETS.fetch(request)
  },
}
