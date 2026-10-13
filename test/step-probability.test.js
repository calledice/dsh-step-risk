import test from 'node:test'
import assert from 'node:assert/strict'
import {
  composeStepFailure,
  estimateStepFailure,
} from '../src/step-probability.js'

const event = (extra = {}) => ({
  kind: 'tool', toolName: 'Bash', outcome: 'unknown', ordinal: 1,
  eventId: 'tool:private-event-id', ...extra,
})
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12)

test('unknown steps have an absolute estimate with declared assumptions', () => {
  const result = estimateStepFailure(event())
  close(result.value, 0.045)
  assert.equal(result.status, 'model_estimate')
  assert.equal(result.source, 'rules')
  assert.equal(result.evidenceQuality, 'low')
  assert.equal(result.modelVersion, 'step-failure-chain-v1')
  assert.deepEqual(result.factors, { problem: 0.15, persistence: 0.6, impact: 0.5 })
  assert.deepEqual(result.evidenceRefs, ['target'])
  assert.ok(result.summary.length > 0)
  assert.ok(result.reasons.length >= 3)
  assert.ok(result.limitations.some(value => /设计先验/.test(value)))
  assert.ok(!JSON.stringify(result).includes('private-event-id'))
})

test('success lowers the problem prior without claiming zero final failure risk', () => {
  const result = estimateStepFailure(event({ outcome: 'success' }))
  close(result.value, 0.012)
  assert.ok(result.value > 0)
  assert.ok(result.value < estimateStepFailure(event()).value)
})

test('an action error differs from an error with unknown operation and is not certainty', () => {
  const unknown = estimateStepFailure(event({ outcome: 'error' }))
  const action = estimateStepFailure(event({ outcome: 'error', operation: 'action' }))
  close(unknown.value, 0.135)
  close(action.value, 0.21)
  assert.ok(action.value > unknown.value)
  assert.ok(action.value < 1)
})

test('read and verification errors do not receive the action failure prior', () => {
  for (const operation of ['read', 'verification']) {
    const result = estimateStepFailure(event({ outcome: 'error', operation }))
    close(result.value, 0.045)
    assert.ok(result.reasons.some(value => /不等于.*制造/.test(value)))
  }
})

test('only known tool operations are inferred and generic execution stays unknown', () => {
  for (const toolName of ['apply_patch', 'functions.apply_patch', 'mcp__filesystem__write_file'])
    close(estimateStepFailure(event({ toolName, outcome: 'error' })).value, 0.21)
  for (const toolName of ['read_file', 'mcp__filesystem__read_file', 'run_tests'])
    close(estimateStepFailure(event({ toolName, outcome: 'error' })).value, 0.045)
  for (const toolName of ['Bash', 'exec_command', 'functions.exec_command', 'mcp__unknown__tool'])
    close(estimateStepFailure(event({ toolName, outcome: 'error', role: 'executor' })).value, 0.135)
})

test('operation metadata is allowlisted and explicit unknown prevents name inference', () => {
  close(estimateStepFailure(event({ operation: 'verification', toolName: 'apply_patch', outcome: 'error' })).value, 0.045)
  close(estimateStepFailure(event({ operation: 'unknown', toolName: 'apply_patch', outcome: 'error' })).value, 0.135)
  const result = estimateStepFailure(event({ operation: 'action; PRIVATE_VALUE', outcome: 'error' }))
  close(result.value, 0.135)
  assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'))
})

test('response text never supplies an outcome or contaminates explanatory metadata', () => {
  const baseline = estimateStepFailure(event())
  for (const response of ['step-risk-ok', 'step-risk-fail', 'exit 7', '<script>PRIVATE_BODY</script>'])
    assert.deepEqual(estimateStepFailure(event({ response })), baseline)
})

test('each step estimate is deterministic and independent of unrelated or legacy weights', () => {
  const target = event({ outcome: 'error', operation: 'action' })
  const before = estimateStepFailure(target)
  for (let i = 0; i < 300; i += 1)
    estimateStepFailure(event({ ordinal: i + 2, outcome: 'success', operation: 'read' }))
  assert.deepEqual(estimateStepFailure(target), before)
  assert.deepEqual(estimateStepFailure({ ...target, pCurrent: 0.00001,
    pResidual: 0.99, taskFailureRisk: { value: 0.001 }, ordinal: 900 }), before)
})

test('malformed or absent outcomes fall back to the unknown prior', () => {
  for (const input of [undefined, null, {}, event({ outcome: 'ok' }), event({ outcome: false })])
    close(estimateStepFailure(input).value, 0.045)
})

test('compose uses conditional factor multiplication without normalization across steps', () => {
  const a = composeStepFailure({ problem: 0.8, persistence: 1, impact: 1 })
  const b = composeStepFailure({ problem: 0.8, persistence: 1, impact: 1 })
  assert.equal(a.value, 0.8)
  assert.equal(b.value, 0.8)
  assert.ok(a.value + b.value > 1)
  assert.equal(composeStepFailure({ problem: 0, persistence: 1, impact: 1 }).value, 0)
  assert.equal(composeStepFailure({ problem: 1, persistence: 1, impact: 1 }).value, 1)
})

test('compose rejects invalid factors instead of coercing or clamping model output', () => {
  for (const name of ['problem', 'persistence', 'impact'])
    for (const value of [undefined, null, true, '0.5', NaN, Infinity, -Infinity, -0.01, 1.01])
      assert.throws(() => composeStepFailure({ problem: 0.5, persistence: 0.5,
        impact: 0.5, [name]: value }), /factor/)
  for (const factors of [undefined, null, [], 0, '0.5'])
    assert.throws(() => composeStepFailure(factors), /factors/)
})

test('compose accepts Luna metadata but cannot override the model-computed contract', () => {
  const result = composeStepFailure({ problem: 0.8, persistence: 0.5, impact: 0.3 }, {
    source: 'luna', evidenceQuality: 'medium', summary: 'Related action has an unresolved error.',
    reasons: ['Structured failure'], limitations: ['Task relevance is uncertain'],
    evidenceRefs: ['target', 'previous-1'], value: 1, status: 'calibrated', modelVersion: 'fake',
  })
  close(result.value, 0.12)
  assert.equal(result.status, 'model_estimate')
  assert.equal(result.modelVersion, 'step-failure-chain-v1')
  assert.equal(result.source, 'luna')
  assert.equal(result.evidenceQuality, 'medium')
  assert.deepEqual(result.evidenceRefs, ['target', 'previous-1'])
})

test('compose copies factor and metadata arrays so later caller changes cannot alter a snapshot', () => {
  const factors = { problem: 0.5, persistence: 0.5, impact: 0.5 }
  const details = { reasons: ['reason'], limitations: ['limit'], evidenceRefs: ['target'] }
  const result = composeStepFailure(factors, details)
  factors.problem = 1
  details.reasons.push('changed')
  details.limitations.push('changed')
  details.evidenceRefs.push('changed')
  assert.equal(result.factors.problem, 0.5)
  assert.deepEqual(result.reasons, ['reason'])
  assert.deepEqual(result.limitations, ['limit'])
  assert.deepEqual(result.evidenceRefs, ['target'])
})

test('compose preserves the output schema and rejects invalid metadata types and enums', () => {
  const factors = { problem: 0.5, persistence: 0.5, impact: 0.5 }
  for (const details of [null, [], { source: 'calibrated' }, { evidenceQuality: 'certain' },
    { summary: {} }, { reasons: 'reason' }, { limitations: [4] }, { evidenceRefs: [{}] }])
    assert.throws(() => composeStepFailure(factors, details), TypeError)
})
