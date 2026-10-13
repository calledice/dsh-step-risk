import test from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshotRoute, registerSnapshotRoute } from '../src/routes.js'

test('snapshot uses the authenticated carrier route and allows only scoped reads', async () => {
  let selected
  const route = createSnapshotRoute({ read(id) { selected = id; return { schemaVersion: 1, steps: [] } } })
  assert.equal(route.path, '/api/dsh-step-risk/snapshot')
  assert.deepEqual(route.methods, ['GET'])
  const response = await route.fetch(new Request('http://localhost' + route.path + '?sessionId=a%2Fb'))
  assert.equal(response.status, 200)
  assert.equal(selected, 'a/b')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.deepEqual(await response.json(), { schemaVersion: 1, steps: [] })
})

test('invalid query and write requests are rejected without touching the store', async () => {
  const route = createSnapshotRoute({ read() { throw new Error('must not read') } })
  for (const query of ['?sessionId=', '?sessionId=a&sessionId=b', '?file=../../secret', '?sessionId=' + 'a'.repeat(513)])
    assert.equal((await route.fetch(new Request('http://localhost' + route.path + query))).status, 400)
  assert.equal((await route.fetch(new Request('http://localhost' + route.path, { method: 'POST' }))).status, 405)
})

test('read failures do not disclose paths or internal exception messages', async () => {
  const route = createSnapshotRoute({ read() { throw new Error('PRIVATE_PATH') } })
  const response = await route.fetch(new Request('http://localhost' + route.path))
  assert.equal(response.status, 503)
  assert.ok(!(await response.text()).includes('PRIVATE_PATH'))
})

test('route lifetime belongs to optional Connection injection and releases registration', async () => {
  let disposed = false
  let registered
  let cleanup
  registerSnapshotRoute({
    inject(names, apply) {
      assert.deepEqual(names, ['connection'])
      apply({
        get(name) { assert.equal(name, 'connection'); return { fetch: { register(route) {
          registered = route
          return async () => { disposed = true }
        } } } },
        effect(effect) { cleanup = effect() },
      })
    },
  }, { read: () => ({ steps: [] }) })
  assert.equal(registered.path, '/api/dsh-step-risk/snapshot')
  await cleanup()
  assert.equal(disposed, true)
})
