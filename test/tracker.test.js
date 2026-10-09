import test from 'node:test'
import assert from 'node:assert/strict'
import { createTracker } from '../src/tracker.js'

const base = {
  baseHazard: 0.1,
  roleOffsets: { planner: 0.5, executor: 0, verifier: 0, other: 0 },
  delegationDepthOffset: 0.1,
  likelihoodRatios: {
    tool_error: 8,
    request_error: 3,
    agent_error: 10,
    interrupted: 2,
    model_attempt: 1.5,
  },
  maxCandidates: 10,
  topK: 3,
}

const observation = (step, extra = {}) => ({
  turn: 1,
  step,
  role: 'other',
  delegationDepth: 0,
  evidenceCodes: [],
  ...extra,
})

test('posterior accounts for retained, pruned, and future mass', () => {
  const tracker = createTracker(base)
  const first = tracker.observeStep('a', observation(1))
  assert.ok(first.pCurrent > 0)
  assert.ok(first.pFuture > 0)
  assert.equal(first.calibration, 'experimental_uncalibrated')
  assert.equal(first.scope, 'conditional_on_eventual_failure_and_responsibility_in_session')
  assert.ok(Math.abs(first.pRetained + first.pOtherPast + first.pFuture - 1) < 1e-12)
  assert.equal(first.topCandidates[0].step, 1)
})

test('a hard tool error raises current-step probability', () => {
  const plain = createTracker(base).observeStep('a', observation(1))
  const errored = createTracker(base).observeStep('a', observation(1, {
    evidenceCodes: ['tool_error'],
  }))
  assert.ok(errored.pCurrent > plain.pCurrent)
  assert.deepEqual(errored.evidenceCodes, ['tool_error'])
})

test('agent architecture changes the prior hazard', () => {
  const ordinary = createTracker(base).observeStep('a', observation(1))
  const planner = createTracker(base).observeStep('a', observation(1, {
    role: 'planner',
    delegationDepth: 2,
  }))
  assert.ok(planner.priorHazard > ordinary.priorHazard)
  assert.ok(planner.pCurrent > ordinary.pCurrent)
})

test('arbitrary trace length uses bounded retained candidates and preserves mass', () => {
  const tracker = createTracker(base)
  let last
  for (let step = 1; step <= 500; step += 1) {
    last = tracker.observeStep('a', observation(step))
  }
  assert.equal(last.ordinal, 500)
  assert.ok(last.retainedCandidates <= base.maxCandidates)
  assert.ok(last.pOtherPast > 0)
  assert.ok(Math.abs(last.pRetained + last.pOtherPast + last.pFuture - 1) < 1e-12)
})

test('sessions are isolated and repeated step completion is idempotent', () => {
  const tracker = createTracker(base)
  const a = tracker.observeStep('a', observation(1, { evidenceCodes: ['tool_error'] }))
  const repeat = tracker.observeStep('a', observation(1, { evidenceCodes: ['tool_error'] }))
  const b = tracker.observeStep('b', observation(1))
  assert.equal(repeat.ordinal, 1)
  assert.deepEqual(repeat, a)
  assert.ok(a.pCurrent > b.pCurrent)
  assert.equal(tracker.getSnapshot('a').sessionId, 'a')
  tracker.forgetSession('a')
  assert.equal(tracker.getSnapshot('a'), null)
  assert.notEqual(tracker.getSnapshot('b'), null)
})

test('invalid model configuration fails before observing events', () => {
  assert.throws(() => createTracker({ ...base, baseHazard: 1 }), /baseHazard/)
  assert.throws(() => createTracker({ ...base, maxCandidates: 0 }), /maxCandidates/)
  assert.throws(() => createTracker({
    ...base,
    likelihoodRatios: { ...base.likelihoodRatios, tool_error: Number.NaN },
  }), /tool_error/)
})

test('late hard evidence remains visible after hundreds of normal steps', () => {
  const tracker = createTracker({
    ...base,
    baseHazard: 0.03,
    recoveryHazard: 0.02,
    likelihoodRatios: { ...base.likelihoodRatios, tool_error: 20, no_hard_signal: 0.25 },
  })
  for (let step = 1; step <= 500; step += 1) {
    tracker.observeStep('late', observation(step))
  }
  const late = tracker.observeStep('late', observation(501, {
    evidenceCodes: ['tool_error'],
  }))
  assert.equal(late.topCandidates[0].step, 501)
  assert.ok(late.pCurrent > 0.1)
  assert.ok(late.pCurrentGivenNoEarlier > late.priorHazard)
})

test('recovery hazard must be a probability', () => {
  assert.throws(() => createTracker({ ...base, recoveryHazard: -0.1 }), /recoveryHazard/)
  assert.throws(() => createTracker({ ...base, recoveryHazard: 1 }), /recoveryHazard/)
})

test('late agent error revises a completed step without adding a new step', () => {
  const tracker = createTracker(base)
  const before = tracker.observeStep('a', observation(1))
  const after = tracker.addEvidence('a', 1, 1, ['agent_error'])
  assert.equal(after.ordinal, 1)
  assert.equal(after.revision, 1)
  assert.ok(after.pCurrent > before.pCurrent)
  assert.deepEqual(after.evidenceCodes, ['agent_error'])
  assert.equal(tracker.addEvidence('a', 1, 1, ['agent_error']), null)
})


test('nested configuration and evidence codes reject unknown keys', () => {
  assert.throws(() => createTracker({ ...base, roleOffsets: [] }), /roleOffsets/)
  assert.throws(() => createTracker({ ...base, roleOffsets: { typo: 1 } }), /roleOffsets/)
  assert.throws(() => createTracker({ ...base, likelihoodRatios: { typo: 2 } }), /likelihoodRatios/)
  const tracker = createTracker(base)
  assert.throws(() => tracker.observeStep('a', observation(1, {
    evidenceCodes: ['toString'],
  })), /unknown evidence code/)
})
