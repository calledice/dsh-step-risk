import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function makeContext() {
  const handlers = new Map()
  const published = []
  return {
    published,
    on(name, handler) {
      const listeners = handlers.get(name) ?? []
      listeners.push(handler)
      handlers.set(name, listeners)
    },
    emit(name, value) {
      published.push({ name, value })
    },
    fire(name, ...args) {
      return (handlers.get(name) ?? []).map(handler => handler(...args))
    },
  }
}

function event(type, turn, step, data = {}) {
  return { type, data: { turn, step, ...data } }
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
