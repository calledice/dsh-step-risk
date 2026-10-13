import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { trainTurnRiskModel } from '../src/turn-risk.js'

function makeContext() {
  const handlers = new Map()
  const published = []
  const routes = []
  return {
    published, routes,
    on(name, handler) {
      const listeners = handlers.get(name) ?? []
      listeners.push(handler)
      handlers.set(name, listeners)
    },
    emit(name, value) {
      published.push({ name, value })
    },
    inject(names, callback) {
      if (!names.includes('connection')) return
      callback({
        get(name) {
          assert.equal(name, 'connection')
          return { fetch: { register(route) { routes.push(route); return () => {} } } }
        },
        effect(effect) { effect() },
      })
    },
    fire(name, ...args) {
      return (handlers.get(name) ?? []).map(handler => handler(...args))
    },
  }
}

function event(type, turn, step, data = {}) {
  return { type, data: { turn, step, ...data } }
}

function evaluatedModelFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-turn-model-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const labeled = Array.from({ length: 120 }, (_, index) => {
    const sessionId = 'training-session-' + index
    const failure = index % 2 === 1
    return {
      sessionId, turn: 1, outcome: failure ? 'failure' : 'success',
      completedAt: new Date(Date.UTC(2026, 9, 13) + index * 60_000).toISOString(),
      steps: [{ sessionId, turn: 1, step: 1, revision: 0,
        outcome: failure ? 'error' : 'success', operation: failure ? 'action' : 'read',
        evidenceCodes: failure ? ['tool_error'] : [] }],
    }
  })
  const result = trainTurnRiskModel(labeled)
  assert.equal(result.eligible, true, JSON.stringify(result.report))
  const file = join(dir, 'model.json')
  writeFileSync(file, JSON.stringify(result.model))
  return file
}

test('step completion publishes a safe architecture-aware estimate', () => {
  const ctx = makeContext()
  apply(ctx, { logToConsole: false, baseHazard: 0.1 })
  const session = {
    id: 'session-a',
    header: { agentPreset: 'orchestrator', delegationDepth: 1, origin: 'subagent' },
  }
  ctx.fire('session/event', session, event('step/start', 1, 1))
  ctx.fire('session/event', session, event('tool/result', 1, 1, {
    message: { isError: true, content: [{ type: 'text', text: 'PRIVATE_SECRET' }] },
  }))
  ctx.fire('session/event', session, event('step/end', 1, 1))
  const predictions = ctx.published.filter(item => item.name === 'step-risk/prediction')
  assert.equal(predictions.length, 1)
  assert.equal(predictions[0].value.sessionId, 'session-a')
  assert.equal(predictions[0].value.role, 'planner')
  assert.equal(predictions[0].value.delegationDepth, 1)
  assert.deepEqual(predictions[0].value.evidenceCodes, ['tool_error'])
  assert.ok(predictions[0].value.pCurrent > 0)
  assert.equal(predictions[0].value.outcome, 'error')
  assert.equal(predictions[0].value.stepFailure.modelVersion, 'step-failure-chain-v1')
  assert.ok(Math.abs(predictions[0].value.stepFailure.value - 0.135) < 1e-12)
  assert.ok(!JSON.stringify(predictions[0].value).includes('PRIVATE_SECRET'))
})

test('request-error observer delegates through the Harness waterfall', async () => {
  const ctx = makeContext()
  apply(ctx, { logToConsole: false })
  const session = { id: 'session-a', header: {} }
  const agent = { session }
  let nextCalls = 0
  const [result] = ctx.fire('agent/request-error', {
    agent, turn: 2, step: 3, provider: 'test',
    failure: { message: 'PRIVATE_SECRET' },
  }, async () => {
    nextCalls += 1
    return { kind: 'retry' }
  })
  assert.deepEqual(await result, { kind: 'retry' })
  assert.equal(nextCalls, 1)
  ctx.fire('session/event', session, event('step/end', 2, 3))
  assert.deepEqual(ctx.published[0].value.evidenceCodes, ['request_error'])
  assert.ok(!JSON.stringify(ctx.published[0].value).includes('PRIVATE_SECRET'))
})

test('sessions are independent and disposal releases tracking state while retaining history', () => {
  const ctx = makeContext()
  apply(ctx, { logToConsole: false })
  const a = { id: 'a', header: { delegationDepth: 0 } }
  const b = { id: 'b', header: { delegationDepth: 0 } }
  ctx.fire('session/event', a, event('step/end', 1, 1))
  ctx.fire('session/event', b, event('step/end', 1, 1))
  ctx.fire('session/disposed', a)
  ctx.fire('session/event', a, event('step/end', 1, 2))
  const values = ctx.published.map(item => item.value)
  assert.equal(values[0].sessionId, 'a')
  assert.equal(values[1].sessionId, 'b')
  assert.equal(values[2].sessionId, 'a')
  assert.equal(values[2].ordinal, 2)
})

test('invalid plugin configuration fails during load', () => {
  assert.throws(() => apply(makeContext(), { baseHazard: -1 }), /baseHazard/)
  assert.throws(() => apply(makeContext(), { logToConsole: 'yes' }), /logToConsole/)
  assert.throws(() => apply(makeContext(), { dataDir: 42 }), /dataDir/)
  assert.throws(() => apply(makeContext(), {
    roleByPreset: { default: 'not-a-role' },
  }), /roleByPreset/)
})

test('late agent error revises the just-finished step', () => {
  const ctx = makeContext()
  apply(ctx, { logToConsole: false })
  const session = { id: 'a', header: {} }
  ctx.fire('session/event', session, event('step/end', 1, 1))
  const before = ctx.published[0].value
  ctx.fire('agent/error', { agent: { session }, turn: 1, step: 1, error: new Error('PRIVATE_SECRET') })
  const after = ctx.published[1].value
  assert.equal(after.revision, 1)
  assert.ok(after.pCurrent > before.pCurrent)
  assert.equal(after.ordinal, before.ordinal)
  assert.equal(after.outcome, 'error')
  assert.ok(after.stepFailure.value > before.stepFailure.value)
  assert.ok(!JSON.stringify(after).includes('PRIVATE_SECRET'))
})

test('duplicate step completion emits only one independent estimate', () => {
  const ctx = makeContext()
  apply(ctx, { logToConsole: false })
  const session = { id: 'once', header: {} }
  ctx.fire('session/event', session, event('step/end', 1, 1))
  ctx.fire('session/event', session, event('step/end', 1, 1))
  assert.equal(ctx.published.length, 1)
  assert.equal(ctx.published[0].value.outcome, 'unknown')
  assert.ok(Math.abs(ctx.published[0].value.stepFailure.value - 0.045) < 1e-12)
})

test('step/start exposes an abstaining turn forecast and completed steps keep it separate', async () => {
  const ctx = makeContext()
  apply(ctx)
  const session = { id: 'forecast-session', header: {} }
  ctx.fire('session/event', session, event('step/start', 1, 1))
  const live = ctx.published.filter(item => item.name === 'step-risk/turn-forecast')
  assert.equal(live.length, 1)
  assert.equal(live[0].value.horizon, 'turn_final_failure')
  assert.equal(live[0].value.value, null)
  const url = 'http://localhost/api/dsh-step-risk/snapshot?sessionId=forecast-session'
  const active = await (await ctx.routes[0].fetch(new Request(url))).json()
  assert.equal(active.activeTurnForecast.value, null)
  assert.equal(active.steps.length, 0)

  ctx.fire('session/event', session, event('step/end', 1, 1))
  const completed = await (await ctx.routes[0].fetch(new Request(url))).json()
  assert.equal(completed.activeTurnForecast, null)
  assert.equal(completed.steps.length, 1)
  assert.equal(completed.steps[0].turnRisk.pre, null)
  assert.equal(completed.steps[0].turnRisk.post, null)
  assert.equal(completed.steps[0].turnRisk.delta, null)
  assert.equal(completed.steps[0].turnRisk.projection, 'retrospective_current_model')
  assert.equal(completed.steps[0].stepFailure.status, 'model_estimate')
  assert.equal(completed.turnRiskModel.status, 'missing_model')
})

test('evaluated model loads into the real event and route flow without turn or session bleed', async t => {
  const ctx = makeContext()
  apply(ctx, { turnRiskModelFile: evaluatedModelFile(t) })
  const a = { id: 'evaluated-a', header: {} }
  const b = { id: 'evaluated-b', header: {} }
  const url = 'http://localhost/api/dsh-step-risk/snapshot?sessionId=evaluated-a'

  ctx.fire('session/event', a, event('step/start', 1, 1))
  const firstPre = ctx.published.at(-1).value
  assert.equal(firstPre.status, 'evaluated_model')
  assert.equal(firstPre.horizon, 'turn_final_failure')
  ctx.fire('session/event', a, event('tool/call', 1, 1, { callId: 'call-1', name: 'write_file' }))
  ctx.fire('session/event', a, event('tool/result', 1, 1, {
    message: { source: { callId: 'call-1' }, isError: true },
  }))
  ctx.fire('session/event', a, event('step/end', 1, 1))
  const completed = await (await ctx.routes[0].fetch(new Request(url))).json()
  assert.equal(completed.turnRiskModel.status, 'ready')
  assert.equal(completed.turnRiskModel.validation.eligible, true)
  assert.ok(completed.turnRiskModel.validation.holdoutTurns >= 30)
  assert.equal(completed.activeTurnForecast, null)
  assert.equal(completed.steps[0].turnRisk.pre, firstPre.value)
  assert.ok(completed.steps[0].turnRisk.post > firstPre.value)
  assert.equal(completed.steps[0].turnRisk.delta,
    completed.steps[0].turnRisk.post - completed.steps[0].turnRisk.pre)
  assert.equal(completed.steps[0].turnRisk.projection, 'retrospective_current_model')
  assert.equal(ctx.published.at(-1).value.turnRisk.post, completed.steps[0].turnRisk.post)
  assert.equal(ctx.published.at(-1).value.turnRisk.projection, 'at_step_end')

  ctx.fire('session/event', a, event('step/start', 1, 2))
  assert.equal(ctx.published.at(-1).value.value, completed.steps[0].turnRisk.post)
  ctx.fire('session/event', a, event('step/end', 1, 2))
  const second = await (await ctx.routes[0].fetch(new Request(url))).json()
  assert.equal(second.steps[1].turnRisk.pre, completed.steps[0].turnRisk.post)
  ctx.fire('session/event', a, event('step/start', 2, 1))
  assert.equal(ctx.published.at(-1).value.value, firstPre.value)
  ctx.fire('session/event', b, event('step/start', 1, 1))
  assert.equal(ctx.published.at(-1).value.value, firstPre.value)
})

test('late terminal error revises only the observed step post-risk', async t => {
  const ctx = makeContext()
  apply(ctx, { turnRiskModelFile: evaluatedModelFile(t) })
  const session = { id: 'late-evaluated', header: {} }
  const url = 'http://localhost/api/dsh-step-risk/snapshot?sessionId=late-evaluated'
  ctx.fire('session/event', session, event('step/start', 1, 1))
  ctx.fire('session/event', session, event('tool/call', 1, 1, { callId: 'read-1', name: 'read_file' }))
  ctx.fire('session/event', session, event('tool/result', 1, 1, {
    message: { source: { callId: 'read-1' }, isError: false },
  }))
  ctx.fire('session/event', session, event('step/end', 1, 1))
  const before = (await (await ctx.routes[0].fetch(new Request(url))).json()).steps[0]
  assert.equal(ctx.published.at(-1).value.turnRisk.projection, 'at_step_end')
  ctx.fire('agent/error', { agent: { session }, turn: 1, step: 1, error: new Error('private text') })
  const after = (await (await ctx.routes[0].fetch(new Request(url))).json()).steps[0]
  assert.equal(after.revision, 1)
  assert.equal(ctx.published.at(-1).value.turnRisk.projection, 'at_revision')
  assert.equal(after.turnRisk.pre, before.turnRisk.pre)
  assert.ok(after.turnRisk.post > before.turnRisk.post)
  assert.equal(JSON.stringify(after).includes('private text'), false)
})

test('a long turn abstains after retention drops earlier steps but a new turn starts clean', async t => {
  const ctx = makeContext()
  apply(ctx, { turnRiskModelFile: evaluatedModelFile(t), maxStepsPerSession: 2 })
  const session = { id: 'retained-tail', header: {} }
  for (let step = 1; step <= 3; step += 1) {
    ctx.fire('session/event', session, event('step/start', 1, step))
    ctx.fire('session/event', session, event('step/end', 1, step))
  }
  const url = 'http://localhost/api/dsh-step-risk/snapshot?sessionId=retained-tail'
  const retained = await (await ctx.routes[0].fetch(new Request(url))).json()
  assert.deepEqual(retained.steps.map(row => row.step), [2, 3])
  assert.ok(retained.steps.every(row => row.turnRisk.status === 'incomplete_prefix'
    && row.turnRisk.post === null))
  ctx.fire('session/event', session, event('step/start', 1, 4))
  const incomplete = ctx.published.at(-1).value
  assert.equal(incomplete.status, 'incomplete_prefix')
  assert.equal(incomplete.value, null)
  ctx.fire('session/event', session, event('step/start', 2, 1))
  const newTurn = ctx.published.at(-1).value
  assert.equal(newTurn.status, 'evaluated_model')
  assert.ok(typeof newTurn.value === 'number')
})
