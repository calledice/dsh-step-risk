import test from 'node:test'
import assert from 'node:assert/strict'
import { createFeatureCollector } from '../src/features.js'

const session = { id: 's', header: { agentPreset: 'coder', delegationDepth: 1 } }
const event = (type, data = {}, step = 1) => ({ type, data: { turn: 1, step, ...data } })
const call = (id, name) => event('tool/call', { callId: id, name, arguments: '{"secret":"PRIVATE_ARGUMENT"}' })
const result = (id, isError) => event('tool/result', {
  message: { source: { kind: 'tool', callId: id }, ...(isError === undefined ? {} : { isError }),
    content: [{ type: 'text', text: 'PRIVATE_RESPONSE error success password' }] },
})
const observe = (events) => {
  const collector = createFeatureCollector()
  for (const item of events) collector.observeSessionEvent(session, item)
  return collector.observeSessionEvent(session, event('step/end'))
}

test('native step groups successful tool results without recording interaction content', () => {
  const value = observe([call('a', 'read'), result('a', false), call('b', 'write'), result('b', false)])
  assert.equal(value.outcome, 'success')
  assert.equal(value.toolCount, 2)
  assert.deepEqual(value.toolNames, ['read', 'write'])
  assert.equal(value.operation, 'unknown')
  assert.ok(!JSON.stringify(value).includes('PRIVATE_'))
})

test('error operation comes from errored calls, not successful neighboring actions', () => {
  assert.equal(observe([call('a', 'read'), result('a', true), call('b', 'write'), result('b', false)]).operation, 'read')
  assert.equal(observe([call('a', 'write'), result('a', true)]).operation, 'action')
  assert.equal(observe([call('a', 'bash'), result('a', true)]).operation, 'unknown')
  assert.equal(observe([call('a', 'read'), result('a', true), call('b', 'write'), result('b', true)]).operation, 'unknown')
})

test('matching foreground bash and pwsh exit codes determine command outcome', () => {
  for (const name of ['bash', 'pwsh']) {
    for (const [exitCode, expected] of [[0, 'success'], [7, 'error']]) {
      const collector = createFeatureCollector()
      collector.observeSessionEvent(session, call('shell', name))
      collector.observeToolResult({ callId: 'shell', name, agent: { session } }, {
        isError: false,
        value: { kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false,
          stdout: { text: 'PRIVATE_STDOUT', truncated: false },
          stderr: { text: 'PRIVATE_STDERR', truncated: false } },
      })
      collector.observeSessionEvent(session, result('shell', false))
      const observed = collector.observeSessionEvent(session, event('step/end'))
      assert.equal(observed.outcome, expected)
      assert.equal(observed.operation, 'unknown')
      assert.equal(observed.evidenceCodes.includes('tool_error'), exitCode !== 0)
      assert.ok(!JSON.stringify(observed).includes('PRIVATE_'))
    }
  }
})

test('shell results without a matched completed status remain unknown', () => {
  const cases = [
    null,
    { isError: false, value: '[Command finished with exit code 7]' },
    { isError: false, value: { kind: 'background', jobId: 'job' } },
    { isError: false, value: { kind: 'foreground', exitCode: 0,
      signal: null, timedOut: true, aborted: false } },
    { isError: false, value: { kind: 'foreground', exitCode: null,
      signal: 'SIGTERM', timedOut: false, aborted: false } },
  ]
  for (const executionResult of cases) {
    const collector = createFeatureCollector()
    collector.observeSessionEvent(session, call('shell', 'bash'))
    if (executionResult) collector.observeToolResult({ callId: 'shell', name: 'bash', agent: { session } }, executionResult)
    collector.observeSessionEvent(session, event('tool/result', {
      message: { source: { callId: 'shell' }, isError: false,
        content: [{ type: 'text', text: 'PRIVATE_RESPONSE\n[exit code: 7]' }] },
    }))
    assert.equal(collector.observeSessionEvent(session, event('step/end')).outcome, 'unknown')
  }
})

test('unmatched sessions and nested shell executions cannot override a root call', () => {
  for (const exec of [
    { callId: 'shell', name: 'bash', agent: { session: { id: 'other' } } },
    { callId: 'shell', name: 'bash', agent: { session }, parent: Symbol('transport') },
    { callId: 'different', name: 'bash', agent: { session } },
  ]) {
    const collector = createFeatureCollector()
    collector.observeSessionEvent(session, call('shell', 'bash'))
    collector.observeToolResult(exec, { isError: false, value: {
      kind: 'foreground', exitCode: 7, signal: null, timedOut: false, aborted: false,
    } })
    collector.observeSessionEvent(session, result('shell', false))
    assert.equal(collector.observeSessionEvent(session, event('step/end')).outcome, 'unknown')
  }
})

test('missing or unpaired result, missing verdict, and model-only completion remain unknown', () => {
  for (const events of [[], [call('a', 'read')], [call('a', 'read'), result('a')],
    [call('a', 'read'), result('a', false), call('b', 'write')],
    [result('a', false)], [call('a', 'read'), result('a', false), result('b', false)],
    [call('unpaired:0', 'read'), result(undefined, false)]])
    assert.equal(observe(events).outcome, 'unknown')
  assert.equal(observe([result('a', true)]).outcome, 'error')
})

test('an error wins over success while duplicate results count once', () => {
  const value = observe([call('a', 'write'), result('a', true), result('a', true), call('b', 'read'), result('b', false)])
  assert.equal(value.outcome, 'error')
  assert.equal(value.toolCount, 2)
  assert.deepEqual(value.evidenceCodes, ['tool_error'])
})

test('request retries stay historical evidence when a later tool succeeds', () => {
  const collector = createFeatureCollector()
  collector.observeRequestError({ agent: { session }, turn: 1, step: 1 })
  collector.observeSessionEvent(session, event('assistant/attempt'))
  collector.observeSessionEvent(session, call('a', 'read'))
  collector.observeSessionEvent(session, result('a', false))
  const value = collector.observeSessionEvent(session, event('step/end'))
  assert.equal(value.outcome, 'success')
  assert.deepEqual(value.evidenceCodes, ['request_error', 'model_attempt'])
})

test('interruption prevents claiming whole-step success and terminal agent errors fail it', () => {
  const value = observe([call('a', 'read'), result('a', false), event('assistant/message', { interrupted: true })])
  assert.equal(value.outcome, 'unknown')
  const collector = createFeatureCollector()
  collector.observeAgentError({ agent: { session }, turn: 1, step: 1 })
  assert.equal(collector.observeSessionEvent(session, event('step/end')).outcome, 'error')
})

test('out of order and malformed events cannot create unbounded orphan state', () => {
  const collector = createFeatureCollector()
  assert.equal(collector.observeSessionEvent(session, event('step/end')).step, 1)
  assert.equal(collector.observeSessionEvent(session, event('step/end')), null)
  assert.equal(collector.observeSessionEvent(session, event('step/end', {}, 0)), null)
  assert.equal(collector.observeSessionEvent({ id: '' }, event('step/end')), null)
  assert.equal(collector.observeSessionEvent(session, event('step/end', { step: -1 })), null)
  collector.forgetSession(session.id)
  assert.equal(collector.observeSessionEvent(session, event('step/end')).step, 1)
})
