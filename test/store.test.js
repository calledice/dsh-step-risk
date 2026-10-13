import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createStore } from '../src/store.js'
import { estimateStepFailure } from '../src/step-probability.js'

const filename = id => createHash('sha256').update(id).digest('hex') + '.json'
const snapshot = (sessionId = 'session-a', step = 1, extra = {}) => {
  const observation = {
    sessionId, turn: 1, step, ordinal: step, revision: 0,
    observedAt: `2026-10-13T06:00:${String(step).padStart(2, '0')}.000Z`,
    role: 'executor', delegationDepth: 0, toolNames: ['write_file'], toolCount: 1,
    outcome: 'success', operation: 'action', evidenceCodes: [], ...extra,
  }
  return { ...observation, stepFailure: extra.stepFailure ?? estimateStepFailure(observation) }
}
const directory = t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-risk-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('memory store returns the latest session and immutable allowlisted records', () => {
  const store = createStore({ dataDir: null })
  assert.deepEqual(store.read(), {
    schemaVersion: 1, pluginVersion: '0.2.0', calibration: 'experimental_uncalibrated',
    sessionId: null, sessions: [], steps: [], updatedAt: null,
  })
  const first = snapshot('older', 1, { prompt: 'DO NOT SAVE', toolArgs: { secret: 'token' } })
  store.put(first)
  first.toolNames.push('changed')
  store.put(snapshot('newer', 2))
  const view = store.read()
  assert.equal(view.sessionId, 'newer')
  assert.deepEqual(view.sessions.map(session => session.sessionId), ['newer', 'older'])
  assert.equal(store.read('older').steps[0].prompt, undefined)
  assert.deepEqual(store.read('older').steps[0].toolNames, ['write_file'])
  view.steps[0].stepFailure.factors.problem = 1
  assert.equal(store.read().steps[0].stepFailure.factors.problem, 0.04)
  assert.deepEqual(store.read('not-observed').steps, [])
  assert.equal(store.read('not-observed').sessionId, 'not-observed')
})

test('duplicate completion is idempotent and newer revision replaces only its own step', () => {
  const store = createStore()
  const first = snapshot('a', 1)
  store.put(first)
  store.put(snapshot('a', 1, { outcome: 'error', revision: 0 }))
  store.put(snapshot('a', 2, { outcome: 'error' }))
  assert.equal(store.read('a').steps.length, 2)
  assert.deepEqual(store.read('a').steps[0].stepFailure, first.stepFailure)
  const revision = snapshot('a', 2, { outcome: 'error', revision: 1, evidenceCodes: ['agent_error'] })
  store.put(revision)
  store.put(snapshot('a', 2, { revision: 0 }))
  assert.equal(store.read('a').steps[1].revision, 1)
  assert.deepEqual(store.read('a').steps[1].evidenceCodes, ['agent_error'])
  assert.deepEqual(store.read('a').steps[0].stepFailure, first.stepFailure)
})

test('atomic hashed session files survive restart and cannot follow a path-like session ID', t => {
  const dataDir = join(directory(t), 'records')
  const id = '../../outside\\session:<id>'
  const store = createStore({ dataDir })
  const input = snapshot(id)
  store.put(input)
  assert.deepEqual(readdirSync(dataDir), [filename(id)])
  const saved = JSON.parse(readFileSync(join(dataDir, filename(id)), 'utf8'))
  assert.equal(saved.sessionId, id)
  assert.deepEqual(createStore({ dataDir }).read(id).steps, [input])
  assert.equal(readdirSync(dataDir).some(file => file.endsWith('.tmp')), false)
})

test('retention bounds sessions on disk and retains the newest step positions', t => {
  const dataDir = directory(t)
  const store = createStore({ dataDir, maxSessions: 2, maxStepsPerSession: 2 })
  store.put(snapshot('old', 1))
  store.put(snapshot('active', 2))
  store.put(snapshot('active', 3))
  store.put(snapshot('active', 4))
  store.put(snapshot('new', 5))
  assert.deepEqual(store.read().sessions.map(item => item.sessionId), ['new', 'active'])
  assert.deepEqual(store.read('active').steps.map(item => item.step), [3, 4])
  assert.equal(readdirSync(dataDir).filter(name => name.endsWith('.json')).length, 2)
  const restarted = createStore({ dataDir, maxSessions: 2, maxStepsPerSession: 2 })
  assert.deepEqual(restarted.read(), store.read())
  assert.deepEqual(restarted.read('old').steps, [])
})

test('writing after a smaller retention setting also removes old durable session records', t => {
  const dataDir = directory(t)
  const original = createStore({ dataDir, maxSessions: 3 })
  original.put(snapshot('old', 1))
  original.put(snapshot('middle', 2))
  original.put(snapshot('recent', 3))
  const smaller = createStore({ dataDir, maxSessions: 1 })
  smaller.put(snapshot('new', 4))
  assert.deepEqual(smaller.read().sessions.map(item => item.sessionId), ['new'])
  assert.deepEqual(readdirSync(dataDir), [filename('new')])
})

test('disk reads reject malformed envelopes, spoofed identities, and invalid model factors', t => {
  const dataDir = directory(t)
  const store = createStore({ dataDir })
  store.put(snapshot('valid'))
  const valid = JSON.parse(readFileSync(join(dataDir, filename('valid')), 'utf8'))
  writeFileSync(join(dataDir, filename('broken')), '{ not valid JSON')
  writeFileSync(join(dataDir, filename('wrong-name')), JSON.stringify(valid))
  const wrongFactor = structuredClone(valid)
  wrongFactor.sessionId = 'wrong-factor'
  wrongFactor.steps[0].sessionId = 'wrong-factor'
  wrongFactor.steps[0].stepFailure.factors.problem = 'injected text'
  writeFileSync(join(dataDir, filename('wrong-factor')), JSON.stringify(wrongFactor))
  const wrongModel = structuredClone(valid)
  wrongModel.sessionId = 'wrong-model'
  wrongModel.steps[0].sessionId = 'wrong-model'
  wrongModel.steps[0].stepFailure.modelVersion = 'untrusted-model'
  writeFileSync(join(dataDir, filename('wrong-model')), JSON.stringify(wrongModel))
  assert.deepEqual(createStore({ dataDir }).read().sessions.map(item => item.sessionId), ['valid'])
})

test('untrusted disk prose and unknown properties cannot reach the viewer', t => {
  const dataDir = directory(t)
  createStore({ dataDir }).put(snapshot('valid'))
  const file = join(dataDir, filename('valid'))
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.steps[0].prompt = 'private prompt'
  saved.steps[0].toolOutput = 'private response'
  saved.steps[0].stepFailure.summary = '<script>arbitrary injected content</script>'
  saved.steps[0].stepFailure.reasons = ['private error text']
  saved.steps[0].stepFailure.evidenceRefs = ['https://attacker.invalid']
  saved.steps[0].stepFailure.extra = { secret: 'private token' }
  writeFileSync(file, JSON.stringify(saved))
  const safe = createStore({ dataDir }).read('valid').steps[0]
  assert.deepEqual(safe.stepFailure, estimateStepFailure(safe))
  assert.equal(safe.prompt, undefined)
  assert.equal(safe.toolOutput, undefined)
  assert.equal(JSON.stringify(safe).includes('private'), false)
})

test('oversized and non-regular record files are skipped without an unbounded read', t => {
  const dataDir = directory(t)
  const store = createStore({ dataDir, maxStepsPerSession: 1 })
  store.put(snapshot('valid'))
  writeFileSync(join(dataDir, filename('huge')), '')
  truncateSync(join(dataDir, filename('huge')), 33 * 1024 * 1024)
  mkdirSync(join(dataDir, filename('directory')))
  writeFileSync(join(dataDir, 'unrelated.txt'), 'not a record')
  assert.deepEqual(createStore({ dataDir, maxStepsPerSession: 1 }).read().sessions.map(item => item.sessionId), ['valid'])
})

test('input validation rejects malformed facts without storing raw interaction content', () => {
  const store = createStore()
  for (const change of [
    { sessionId: '' }, { sessionId: 'bad\nname' }, { step: -1 }, { revision: NaN },
    { outcome: 'made up' }, { operation: 'shell' }, { role: 'attacker' },
    { toolNames: ['please save my prompt here'] }, { evidenceCodes: ['raw error text'] },
    { observedAt: 'invalid date' }, { toolCount: -1 },
    { stepFailure: { modelVersion: 'step-failure-chain-v1', value: 1 } },
  ]) assert.throws(() => store.put(snapshot('a', 1, change)), /invalid/i)
  assert.equal(store.read().steps.length, 0)
  assert.throws(() => createStore({ maxSessions: 0 }), /maxSessions/)
  assert.throws(() => createStore({ maxStepsPerSession: -1 }), /maxStepsPerSession/)
})

test('clearMemory releases cached rows while durable records can be reloaded', t => {
  const dataDir = directory(t)
  const durable = createStore({ dataDir })
  durable.put(snapshot())
  durable.clearMemory()
  assert.equal(durable.read().steps.length, 1)
  const transient = createStore()
  transient.put(snapshot())
  transient.clearMemory()
  assert.deepEqual(transient.read().steps, [])
})
