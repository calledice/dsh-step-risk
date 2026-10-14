import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../src/store.js'
import { STEP_OBSERVATION_VERSION } from '../src/features.js'
import { estimateStepFailure } from '../src/step-probability.js'
import { loadTurnRiskModel } from '../src/turn-risk.js'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const baseTime = Date.UTC(2026, 9, 13)
const timestamp = index => new Date(baseTime + index * 60_000).toISOString()
const recordName = id => createHash('sha256').update(id).digest('hex') + '.json'

function fixture(t, count = 1, outcomeOf = index => index % 2 ? 'failure' : 'success') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-turn-risk-train-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const records = join(root, 'records')
  const labels = join(root, 'private-labels.jsonl')
  const model = join(root, 'turn-risk-model-v2.json')
  const report = join(root, 'aggregate-report.json')
  const store = createStore({ dataDir: records, maxSessions: 1000 })
  const lines = []
  for (let index = 0; index < count; index += 1) {
    const sessionId = 'private-session-' + index
    const outcome = outcomeOf(index)
    const observation = {
      sessionId, turn: 1, step: 1, ordinal: 1, revision: 0,
      observationVersion: STEP_OBSERVATION_VERSION,
      observedAt: timestamp(index), role: 'executor', delegationDepth: 0,
      toolNames: ['write_file'], toolCount: 1,
      outcome: outcome === 'failure' ? 'error' : 'success',
      operation: 'action', evidenceCodes: outcome === 'failure' ? ['tool_error'] : [],
    }
    store.put({ ...observation, stepFailure: estimateStepFailure(observation) })
    lines.push(JSON.stringify({ sessionId, turn: 1, outcome, completedAt: timestamp(index) }))
  }
  writeFileSync(labels, lines.join('\n') + '\n')
  return { root, records, labels, model, report }
}

function run(f, extra = []) {
  const child = spawnSync(process.execPath, [
    'scripts/train-turn-risk.mjs',
    '--records', f.records, '--labels', f.labels, '--model', f.model,
    '--report', f.report, ...extra,
  ], { cwd: repo, encoding: 'utf8', timeout: 30_000 })
  assert.equal(child.error, undefined)
  const parsed = JSON.parse(child.stdout.trim())
  return { child, parsed }
}

test('CLI writes only aggregate model and report for an eligible synthetic data set', t => {
  const f = fixture(t, 120)
  const firstRecord = join(f.records, recordName('private-session-0'))
  const injected = JSON.parse(readFileSync(firstRecord, 'utf8'))
  injected.steps[0].rawPrompt = 'PRIVATE_PROMPT_MARKER'
  injected.privateOutput = 'PRIVATE_OUTPUT_MARKER'
  writeFileSync(firstRecord, JSON.stringify(injected))
  const { child, parsed } = run(f)
  assert.equal(child.status, 0, child.stderr)
  assert.equal(parsed.status, 'eligible')
  assert.equal(parsed.eligible, true)
  assert.equal(parsed.modelWritten, true)
  assert.equal(parsed.existingModelRetained, false)
  const modelText = readFileSync(f.model, 'utf8')
  const reportText = readFileSync(f.report, 'utf8')
  for (const text of [modelText, reportText, child.stdout]) {
    assert.equal(text.includes('private-session-'), false)
    assert.equal(text.includes('PRIVATE_PROMPT_MARKER'), false)
    assert.equal(text.includes('PRIVATE_OUTPUT_MARKER'), false)
  }
  const model = JSON.parse(modelText)
  assert.equal(model.gate.eligible, true)
  assert.ok(model.gate.holdoutTurns >= 30)
  assert.equal(loadTurnRiskModel(f.model).status, 'ready')
  assert.deepEqual(JSON.parse(reportText), parsed)
})

test('CLI reports missing, conflicting, and incomplete private labels without producing a model', t => {
  for (const type of ['missing_records', 'conflicting_labels', 'invalid_labels', 'future_observation']) {
    const f = fixture(t)
    const original = readFileSync(f.labels, 'utf8').trim()
    const label = JSON.parse(original)
    if (type === 'missing_records') label.sessionId = 'unrecorded-private-session'
    if (type === 'invalid_labels') delete label.completedAt
    if (type === 'future_observation') label.completedAt = timestamp(-1)
    const content = type === 'conflicting_labels'
      ? original + '\n' + JSON.stringify({ ...label, outcome: 'failure' }) + '\n'
      : JSON.stringify(label) + '\n'
    writeFileSync(f.labels, content)
    const { child, parsed } = run(f)
    assert.equal(child.status, 1)
    assert.equal(parsed.eligible, false)
    assert.equal(parsed.modelWritten, false)
    assert.equal(parsed.existingModelRetained, false)
    assert.ok(parsed.reasons.includes(type === 'future_observation' ? 'invalid_labels' : type), JSON.stringify(parsed))
    assert.equal(readFileSync(f.report, 'utf8').includes('private-session'), false)
    assert.equal(child.stdout.includes('private-session'), false)
    assert.throws(() => readFileSync(f.model, 'utf8'), /ENOENT/)
  }
})

test('CLI rejects legacy step observations after the shell outcome contract changes', t => {
  const f = fixture(t, 120)
  const file = join(f.records, recordName('private-session-0'))
  const envelope = JSON.parse(readFileSync(file, 'utf8'))
  delete envelope.steps[0].observationVersion
  writeFileSync(file, JSON.stringify(envelope))
  const { child, parsed } = run(f)
  assert.equal(child.status, 1)
  assert.equal(parsed.modelWritten, false)
  assert.ok(parsed.reasons.includes('legacy_observations'), JSON.stringify(parsed))
  assert.throws(() => readFileSync(f.model, 'utf8'), /ENOENT/)
})

test('CLI with no success class keeps the trained model unavailable', t => {
  const f = fixture(t, 120, () => 'failure')
  const { child, parsed } = run(f)
  assert.equal(child.status, 1)
  assert.equal(parsed.status, 'ineligible')
  assert.equal(parsed.modelWritten, false)
  assert.ok(parsed.reasons.includes('insufficient_class_support'), JSON.stringify(parsed))
  assert.throws(() => readFileSync(f.model, 'utf8'), /ENOENT/)
})

test('CLI rejects output paths that collide with private input', t => {
  const f = fixture(t)
  const before = readFileSync(f.labels, 'utf8')
  f.model = f.labels
  const { child, parsed } = run(f)
  assert.equal(child.status, 1)
  assert.equal(parsed.modelWritten, false)
  assert.ok(parsed.reasons.includes('unsafe_output_path'))
  assert.equal(readFileSync(f.labels, 'utf8'), before)
})

test('CLI permits named model and report files beside records as shown in the README', t => {
  const f = fixture(t, 120)
  f.model = join(f.records, 'turn-risk-model-v2.json')
  f.report = join(f.records, 'turn-risk-evaluation.json')
  const { child, parsed } = run(f)
  assert.equal(child.status, 0, child.stderr)
  assert.equal(parsed.modelWritten, true)
  assert.equal(loadTurnRiskModel(f.model).status, 'ready')
})

test('CLI rejects a model path in the hashed private record namespace', t => {
  const f = fixture(t)
  f.model = join(f.records, recordName('private-session-0'))
  const before = readFileSync(f.model, 'utf8')
  const { child, parsed } = run(f)
  assert.equal(child.status, 1)
  assert.equal(parsed.modelWritten, false)
  assert.ok(parsed.reasons.includes('unsafe_output_path'))
  assert.equal(readFileSync(f.model, 'utf8'), before)
})

test('CLI never overwrites unrelated existing JSON files or non-JSON outputs', t => {
  for (const option of ['model', 'report']) {
    const f = fixture(t)
    const unrelated = join(f.root, 'package.json')
    const before = '{"name":"unrelated-file"}\n'
    writeFileSync(unrelated, before)
    f[option] = unrelated
    const { child, parsed } = run(f)
    assert.equal(child.status, 1)
    assert.ok(parsed.reasons.includes('unsafe_output_path'))
    assert.equal(readFileSync(unrelated, 'utf8'), before)
  }
  const f = fixture(t)
  f.model = join(f.root, 'model.txt')
  const { child, parsed } = run(f)
  assert.equal(child.status, 1)
  assert.ok(parsed.reasons.includes('unsafe_output_path'))
})

test('an ineligible retrain reports and preserves the prior eligible model', t => {
  const f = fixture(t, 120)
  assert.equal(run(f).child.status, 0)
  assert.equal(loadTurnRiskModel(f.model).status, 'ready')
  assert.equal(run(f).child.status, 0)
  const lines = readFileSync(f.labels, 'utf8').trim().split('\n')
  writeFileSync(f.labels, lines.map(line => JSON.stringify({ ...JSON.parse(line), outcome: 'failure' })).join('\n') + '\n')
  const { child, parsed } = run(f)
  assert.equal(child.status, 1)
  assert.equal(parsed.eligible, false)
  assert.equal(parsed.modelWritten, false)
  assert.equal(parsed.existingModelRetained, true)
  assert.ok(parsed.reasons.includes('insufficient_class_support'))
  assert.equal(loadTurnRiskModel(f.model).status, 'ready')
})
