const PATH = '/api/dsh-step-risk/snapshot'
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

// Connection's Web and Desktop carriers perform trust/authentication before
// dispatch. Do not expose a second unguarded route on the raw web server.
export function createSnapshotRoute(store) {
  return {
    path: PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405, headers })
      const query = new URL(request.url).searchParams
      const sessionId = query.get('sessionId')
      if ([...query.keys()].some(key => key !== 'sessionId') || query.getAll('sessionId').length > 1
        || (sessionId !== null && (!sessionId.length || sessionId.length > 512 || /[\x00-\x1f]/.test(sessionId))))
        return Response.json({ error: 'invalid session query' }, { status: 400, headers })
      try {
        return Response.json(store.read(sessionId ?? undefined), { headers })
      } catch {
        return Response.json({ error: 'step-risk records unavailable' }, { status: 503, headers })
      }
    },
  }
}

export function registerSnapshotRoute(ctx, store) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], inner => {
    inner.effect(() => inner.get('connection').fetch.register(createSnapshotRoute(store)), 'dsh-step-risk: snapshot')
  })
}
