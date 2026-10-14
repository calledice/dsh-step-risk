import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  summarizeTurnPrefix,
  normalizeCompletedAt,
  trainTurnRiskModel,
  predictTurnRisk,
  projectTurnRisk,
  loadTurnRiskModel,
} from '../src/turn-risk.js'
import { STEP_OBSERVATION_VERSION } from '../src/features.js'

const baseTime = Date.UTC(2026, 9, 13)
const timestamp = index => new Date(baseTime + index * 60_000).toISOString()
const stepRow = (sessionId, turn, step, changes = {}) => ({
  sessionId, turn, step, ordinal: step, revision: 0,
  observationVersion: STEP_OBSERVATION_VERSION,
  outcome: 'success', operation: 'action', evidenceCodes: [], ...changes,
})

function labeledTurns(count = 120, outcomeOf = index => index % 2 ? 'failure' : 'success') {
  return Array.from({ length: count }, (_, index) => {
    const sessionId = 'private-session-' + index
    const outcome = outcomeOf(index)
    return {
      sessionId, turn: 1, outcome, completedAt: timestamp(index),
      steps: [stepRow(sessionId, 1, 1, outcome === 'failure'
        ? { outcome: 'error', operation: 'action', evidenceCodes: ['tool_error'] } : {})],
    }
  })
}

function readyModel() {
  const training = trainTurnRiskModel(labeledTurns())
  assert.equal(training.eligible, true, JSON.stringify(training.report))
  return { status: 'ready', model: training.model }
}

test('prefix summary uses completed structured steps and distinguishes read and action errors', () => {
  assert.deepEqual(summarizeTurnPrefix([]), {
    completedSteps: '0', maxError: 'none', requestError: false,
  })
  const read = stepRow('s', 1, 1, { outcome: 'error', operation: 'read' })
  const action = stepRow('s', 1, 2, { outcome: 'error', operation: 'action' })
  assert.equal(summarizeTurnPrefix([read]).maxError, 'probe')
  assert.equal(summarizeTurnPrefix([action]).maxError, 'action')
  assert.deepEqual(summarizeTurnPrefix([read, action, stepRow('s', 1, 2, {
    revision: 1, outcome: 'success', evidenceCodes: ['request_error'],
  })]), {
    completedSteps: '2-3', maxError: 'probe', requestError: true,
  })
})

test('session-separated chronological training passes a clear synthetic signal without identifiers in the model', () => {
  const result = trainTurnRiskModel(labeledTurns())
  assert.equal(result.eligible, true, JSON.stringify(result.report))
  assert.equal(result.report.trainingTurns + result.report.holdoutTurns, 120)
  assert.ok(result.report.holdoutTurns >= 30)
  assert.ok(result.report.trainingSessions > 0)
  assert.ok(result.report.holdoutSessions > 0)
  assert.ok(result.report.metrics.model.brier <= result.report.metrics.baseline.brier)
  assert.ok(result.report.metrics.model.logLoss <= result.report.metrics.baseline.logLoss)
  assert.ok(result.report.metrics.model.ece5 <= 0.10)
  assert.equal(JSON.stringify(result.model).includes('private-session'), false)
  assert.equal(JSON.stringify(result.model).includes('completedAt'), false)
  assert.equal(JSON.stringify(result.model).includes('"steps"'), false)
})

test('prediction keeps the first pre state independent of the current result and uses observed error classes only', () => {
  const state = readyModel()
  const empty = predictTurnRisk(state, [])
  const read = predictTurnRisk(state, [stepRow('s', 1, 1, { outcome: 'error', operation: 'read' })])
  const action = predictTurnRisk(state, [stepRow('s', 1, 1, { outcome: 'error', operation: 'action' })])
  assert.equal(empty.status, 'evaluated_model')
  assert.equal(empty.horizon, 'turn_final_failure')
  assert.ok(action.value > read.value)
  assert.ok(action.value > empty.value)
  assert.ok(Number.isInteger(action.support) && action.support > 0)
  const firstRead = projectTurnRisk([stepRow('s', 1, 1, { outcome: 'error', operation: 'read' })], state)[0]
  const firstAction = projectTurnRisk([stepRow('s', 1, 1, { outcome: 'error', operation: 'action' })], state)[0]
  assert.equal(firstRead.turnRisk.pre, firstAction.turnRisk.pre)
  assert.equal(firstAction.turnRisk.post, action.value)
  assert.equal(firstAction.turnRisk.delta, firstAction.turnRisk.post - firstAction.turnRisk.pre)
  assert.equal(firstAction.turnRisk.projection, 'retrospective_current_model')
})

test('projection uses strict same-turn prefixes, latest revisions, and never looks ahead', () => {
  const state = readyModel()
  const first = stepRow('s', 1, 1)
  const second = stepRow('s', 1, 2)
  const nextTurn = stepRow('s', 2, 1)
  const otherSession = stepRow('other', 1, 1)
  const original = [first, second, nextTurn, otherSession]
  const projected = projectTurnRisk(original, state)
  assert.notStrictEqual(projected[0], original[0])
  assert.equal(original[0].turnRisk, undefined)
  assert.equal(projected[0].turnRisk.post, projectTurnRisk([first], state)[0].turnRisk.post)
  assert.equal(projected[1].turnRisk.pre, projected[0].turnRisk.post)
  assert.equal(projected[2].turnRisk.pre, projected[0].turnRisk.pre)
  assert.equal(projected[3].turnRisk.pre, projected[0].turnRisk.pre)
  const revised = projectTurnRisk([stepRow('s', 1, 1, {
    revision: 1, outcome: 'error', operation: 'action',
  }), second], state)
  assert.equal(revised[0].turnRisk.pre, projected[0].turnRisk.pre)
  assert.ok(revised[0].turnRisk.post > projected[0].turnRisk.post)
  assert.equal(revised[1].turnRisk.pre, revised[0].turnRisk.post)
})

test('missing or invalid models abstain, including malformed and oversized files', t => {
  const rows = [stepRow('s', 1, 1)]
  for (const status of ['missing_model', 'invalid_model']) {
    const state = { status, model: null }
    assert.deepEqual(predictTurnRisk(state, rows), {
      status, horizon: 'turn_final_failure', value: null, modelVersion: null, support: null,
    })
    assert.deepEqual(projectTurnRisk(rows, state)[0].turnRisk, {
      status, horizon: 'turn_final_failure', pre: null, post: null, delta: null,
      modelVersion: null, support: null, projection: 'retrospective_current_model',
    })
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-turn-risk-model-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'model.json')
  assert.equal(loadTurnRiskModel(file).status, 'missing_model')
  writeFileSync(file, '{bad JSON')
  assert.equal(loadTurnRiskModel(file).status, 'invalid_model')
  const model = readyModel().model
  writeFileSync(file, JSON.stringify({ ...model, secretPrompt: 'PRIVATE' }))
  assert.equal(loadTurnRiskModel(file).status, 'invalid_model')
  writeFileSync(file, JSON.stringify(model))
  assert.equal(loadTurnRiskModel(file).status, 'ready')
  writeFileSync(file, JSON.stringify({ ...model,
    modelVersion: 'turn-failure-empirical-v1', featureVersion: 'turn-prefix-structured-v1',
  }))
  assert.equal(loadTurnRiskModel(file).status, 'invalid_model')
  truncateSync(file, 300_000)
  assert.equal(loadTurnRiskModel(file).status, 'invalid_model')
})

test('insufficient labels or one class never produce a loadable model', () => {
  for (const labels of [labeledTurns(99), labeledTurns(120, () => 'failure')]) {
    const result = trainTurnRiskModel(labels)
    assert.equal(result.eligible, false)
    assert.equal(result.model, null)
    assert.ok(result.report.reasons.length > 0)
  }
})

test('an interleaved session cannot place later training turns before an earlier held-out turn', () => {
  const labels = labeledTurns()
  const sharedSession = labels[0].sessionId
  labels[119] = {
    ...labels[119], sessionId: sharedSession, turn: 2,
    steps: [stepRow(sharedSession, 2, 1, { outcome: 'error', operation: 'action' })],
  }
  const result = trainTurnRiskModel(labels)
  assert.equal(result.eligible, false)
  assert.equal(result.model, null)
  assert.ok(result.report.reasons.includes('insufficient_temporal_split'))
})

test('completion timestamps require an explicit offset and a real calendar date', () => {
  assert.equal(normalizeCompletedAt('2026-10-13T16:00:00+08:00'), '2026-10-13T08:00:00.000Z')
  for (const value of ['2026-10-13 08:00:00', '2026-10-13T08:00:00',
    '2026-02-30T08:00:00Z', '2026-10-13T08:00:00+14:30']) {
    assert.equal(normalizeCompletedAt(value), null)
    const labels = labeledTurns()
    labels[0].completedAt = value
    assert.throws(() => trainTurnRiskModel(labels), /invalid manually labeled turn/)
  }
})

test('retained tails and missing steps abstain instead of losing earlier error history', () => {
  const state = readyModel()
  const retainedTail = [stepRow('s', 1, 2), stepRow('s', 1, 3)]
  const atStart = predictTurnRisk(state, retainedTail, 4)
  assert.equal(atStart.status, 'incomplete_prefix')
  assert.equal(atStart.value, null)
  const projected = projectTurnRisk(retainedTail, state)
  assert.ok(projected.every(row => row.turnRisk.status === 'incomplete_prefix'
    && row.turnRisk.pre === null && row.turnRisk.post === null))
  assert.equal(predictTurnRisk(state, [], 4).status, 'incomplete_prefix')
  const labels = labeledTurns()
  labels[0].steps = [stepRow(labels[0].sessionId, 1, 2)]
  assert.throws(() => trainTurnRiskModel(labels), /incomplete step prefix/)
})

test('legacy step observations abstain without hiding earlier valid prefixes', () => {
  const state = readyModel()
  const first = stepRow('s', 1, 1)
  const legacy = stepRow('s', 1, 2, { observationVersion: undefined })
  const third = stepRow('s', 1, 3)
  assert.equal(predictTurnRisk(state, [first, legacy]).status, 'legacy_observation')
  assert.equal(predictTurnRisk(state, [first, legacy]).value, null)
  const projected = projectTurnRisk([first, legacy, third], state)
  assert.equal(projected[0].turnRisk.status, 'evaluated_model')
  assert.equal(projected[1].turnRisk.status, 'legacy_observation')
  assert.equal(projected[1].turnRisk.pre, projected[0].turnRisk.post)
  assert.equal(projected[1].turnRisk.post, null)
  assert.equal(projected[2].turnRisk.pre, null)
  assert.equal(projected[2].turnRisk.post, null)
  const labels = labeledTurns()
  labels[0].steps[0].observationVersion = undefined
  assert.throws(() => trainTurnRiskModel(labels), /legacy step observation/)
})
