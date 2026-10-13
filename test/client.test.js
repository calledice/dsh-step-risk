import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const clientPath = new URL('../client.js', import.meta.url)

// A deterministic hook host exercises the published classic-script entry and
// request lifecycle without requiring a second copy of DSH's React runtime.
function harness({ protocol = 'dsh-app:', fetcher, native = true } = {}) {
  const registered = new Map()
  const tabs = []
  const disposed = []
  const timers = new Map()
  const state = []
  const effects = []
  let index = 0
  let pending = []
  let dirty = false
  let root
  let props
  let tree
  let plugin
  let timerId = 0
  const requests = []
  const React = {
    createElement(type, attrs, ...children) {
      const values = { ...attrs, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) }
      return typeof type === 'function' ? type(values) : { type, props: values }
    },
    useState(initial) {
      const key = index++
      if (!(key in state)) state[key] = typeof initial === 'function' ? initial() : initial
      return [state[key], value => {
        const next = typeof value === 'function' ? value(state[key]) : value
        if (!Object.is(state[key], next)) { state[key] = next; dirty = true }
      }]
    },
    useEffect(effect, deps) {
      const key = index++
      const old = effects[key]
      if (!old || deps.some((x, i) => !Object.is(x, old.deps[i]))) {
        pending.push(() => {
          old?.cleanup?.()
          effects[key] = { deps, cleanup: effect() }
        })
      }
    },
  }
  const slots = {
    inject(name, callback) { return callback() },
    register(spec, component) {
      registered.set(spec.name + ':' + (spec.key ?? spec.id), { spec, component })
      return () => registered.delete(spec.name + ':' + (spec.key ?? spec.id))
    },
  }
  const services = { slots, sidebarRightTabs: { register(value) { tabs.push(value); return () => tabs.pop() } } }
  const ctx = {
    get: name => services[name],
    effect(callback) { disposed.push(callback()) },
    inject(names, callback) { if (native || !names.includes('sidebarRightTabs')) callback(ctx) },
  }
  vm.runInNewContext(readFileSync(clientPath, 'utf8'), {
    window: { location: { protocol }, __ModuleLoader__: { load(entry) {
      assert.equal(entry.id, 'dsh-step-risk')
      plugin = entry.factory(name => { assert.equal(name, 'react'); return React })
    } } },
    AbortController,
    fetch: async (url, options) => {
      requests.push({ url, options })
      return fetcher ? fetcher(url, options) : { ok: true, json: async () => snapshot() }
    },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    Date, console,
  })
  plugin.apply(ctx)
  function render() {
    index = 0
    dirty = false
    tree = root(props)
    const run = pending
    pending = []
    run.forEach(callback => callback())
  }
  return {
    plugin, registered, tabs, requests, timers,
    get tree() { return tree },
    mount(key, value = {}) { root = registered.get(key).component; props = value; render() },
    update(value) { props = value; render() },
    async flush() {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setImmediate(resolve))
        if (!dirty) break
        render()
      }
    },
    tick() { const ready = [...timers.values()]; timers.clear(); ready.forEach(callback => callback()) },
    unmount() { effects.forEach(effect => effect?.cleanup?.()) },
    dispose() { disposed.reverse().forEach(cleanup => cleanup?.()) },
  }
}

function snapshot(steps = [], sessionId = 'session-a') {
  return {
    schemaVersion: 1, pluginVersion: '0.2.0', calibration: 'experimental_uncalibrated',
    sessionId, sessions: [{ sessionId: 'session-a', updatedAt: '2026-10-13T00:00:00Z', stepCount: steps.length }],
    steps, updatedAt: '2026-10-13T00:00:00Z',
  }
}

function step(ordinal, value, extra = {}) {
  return {
    sessionId: 'session-a', turn: 1, step: ordinal, ordinal, revision: 1,
    observedAt: '2026-10-13T00:00:00Z', role: 'worker', delegationDepth: 0,
    toolNames: ['read_file'], toolCount: 1, outcome: 'success', operation: 'read', evidenceCodes: [],
    stepFailure: { modelVersion: 'step-failure-chain-v1', status: 'model_estimate', value,
      source: 'rules', factors: { problem: 0.2, persistence: 0.3, impact: 0.4 },
      evidenceQuality: 'low', summary: '只读步骤', reasons: ['工具返回成功'], limitations: ['尚未校准'], evidenceRefs: [] },
    ...extra,
  }
}

function nodes(tree, type) {
  if (tree === null || typeof tree !== 'object') return []
  return [...(tree.type === type ? [tree] : []), ...(tree.props?.children ?? []).flatMap(child => nodes(child, type))]
}

function textContent(tree) {
  if (tree === null || tree === undefined || tree === false) return ''
  if (typeof tree !== 'object') return String(tree)
  return (tree.props?.children ?? []).map(textContent).join(' ')
}

const nativeKey = 'sidebar.right.pane.tab:dsh-step-risk/overview'
const settingsKey = 'settings.section:dsh-step-risk'
const nativeProps = (sessionId = 'session-a', visible = true) => ({ sessionId, useTabInfo: () => ({ tab: { visible } }) })

test('classic client registers an optional native tab and an independently usable settings page', () => {
  const app = harness()
  assert.equal(app.plugin.name, 'dsh-step-risk')
  assert.ok(app.registered.has(nativeKey))
  assert.ok(app.registered.has(settingsKey))
  assert.equal(app.tabs[0].guide[0].id, 'overview')
  assert.equal(app.tabs[0].kind, 'dsh-step-risk/overview')
  const fallback = harness({ native: false })
  assert.ok(fallback.registered.has(settingsKey))
  assert.equal(fallback.tabs.length, 0)
  app.dispose()
  assert.equal(app.tabs.length, 0)
  assert.equal(app.registered.size, 0)
})

test('native view scopes desktop GET reads, renders decimals and never sends a body', async () => {
  const app = harness({ fetcher: async () => ({ ok: true, json: async () => snapshot([step(1, 0.024)]) }) })
  app.mount(nativeKey, nativeProps('session / a'))
  await app.flush()
  assert.equal(app.requests[0].url, '/api/dsh-step-risk/snapshot?sessionId=session%20%2F%20a')
  assert.equal(app.requests[0].options.method, 'GET')
  assert.equal(app.requests[0].options.body, undefined)
  const text = textContent(app.tree)
  assert.match(text, /每步最终失败概率（模型估计）/)
  assert.match(text, /2\.4%/)
  assert.match(text, /experimental_uncalibrated/)
  assert.match(text, /成功/)
  assert.match(text, /20\.0%/)
  app.unmount()
  assert.equal(app.timers.size, 0)
})

test('web uses the authenticated API route and hidden native tabs stop polling', async () => {
  const app = harness({ protocol: 'https:' })
  app.mount(nativeKey, nativeProps('a', false))
  await app.flush()
  assert.equal(app.requests.length, 0)
  app.update(nativeProps('a', true))
  await app.flush()
  assert.equal(app.requests[0].url, '/api/dsh-step-risk/snapshot?sessionId=a')
  app.update(nativeProps('a', false))
  assert.equal(app.requests[0].options.signal.aborted, true)
  assert.equal(app.timers.size, 0)
})

test('risk sorting changes presentation without combining independent probabilities', async () => {
  const app = harness({ fetcher: async () => ({ ok: true, json: async () => snapshot([step(1, 0.02), step(2, 0.30)]) }) })
  app.mount(nativeKey, nativeProps())
  await app.flush()
  assert.match(textContent(nodes(app.tree, 'article')[0]), /2\.0%/)
  const sort = nodes(app.tree, 'select').find(node => node.props['aria-label'] === '步骤排序')
  sort.props.onChange({ target: { value: 'risk' } })
  await app.flush()
  assert.match(textContent(nodes(app.tree, 'article')[0]), /30\.0%/)
  assert.match(textContent(app.tree), /不相加/)
  app.unmount()
})

test('global settings selects a session from the catalog and fetches it explicitly', async () => {
  const app = harness()
  app.mount(settingsKey)
  await app.flush()
  assert.equal(app.requests[0].url, '/api/dsh-step-risk/snapshot')
  assert.equal(app.requests[1].url, '/api/dsh-step-risk/snapshot?sessionId=session-a')
  assert.match(textContent(app.tree), /暂无已完成步骤/)
  app.unmount()
})

test('late response from an old session cannot overwrite the current session', async () => {
  const deferred = []
  const app = harness({ fetcher: (url, options) => new Promise(resolve => deferred.push({ url, options, resolve })) })
  app.mount(nativeKey, nativeProps('old'))
  app.update(nativeProps('new'))
  assert.equal(deferred[0].options.signal.aborted, true)
  deferred[1].resolve({ ok: true, json: async () => snapshot([step(9, 0.09)], 'new') })
  await app.flush()
  deferred[0].resolve({ ok: true, json: async () => snapshot([step(1, 0.91)], 'old') })
  await app.flush()
  assert.match(textContent(app.tree), /9\.0%/)
  assert.doesNotMatch(textContent(app.tree), /91\.0%/)
  app.unmount()
})

test('failed polling preserves the last data and shows a visible error', async () => {
  let calls = 0
  const app = harness({ fetcher: async () => ++calls === 1
    ? { ok: true, json: async () => snapshot([step(1, 0.024)]) }
    : { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) } })
  app.mount(nativeKey, nativeProps())
  await app.flush()
  app.tick()
  await app.flush()
  assert.match(textContent(app.tree), /2\.4%/)
  assert.match(textContent(app.tree), /503/)
  assert.equal(nodes(app.tree, 'div').some(node => node.props.role === 'alert'), true)
  app.unmount()
})

test('untrusted tool names are plain React text and a no-tool step remains visible', async () => {
  const payload = '<img src=x onerror=alert(1)>'
  const app = harness({ fetcher: async () => ({ ok: true, json: async () => snapshot([
    step(1, 0.024, { toolNames: [payload] }),
    step(2, 0.012, { toolNames: [], toolCount: 0, outcome: 'unknown' }),
  ]) }) })
  app.mount(nativeKey, nativeProps())
  await app.flush()
  assert.match(textContent(app.tree), /无工具调用/)
  assert.match(textContent(app.tree), /未知/)
  assert.ok(textContent(app.tree).includes(payload))
  assert.equal(nodes(app.tree, 'img').length, 0)
  assert.equal(JSON.stringify(app.tree).includes('dangerouslySetInnerHTML'), false)
  app.unmount()
})
