#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createStore } from '../src/store.js'
import { loadTurnRiskModel, normalizeCompletedAt, trainTurnRiskModel } from '../src/turn-risk.js'

const MAX_LABEL_BYTES = 16 * 1024 * 1024
const MAX_REPORT_BYTES = 256 * 1024
const MAX_LABEL_LINES = 50_000
const MAX_LABEL_LINE_BYTES = 4096
const ARGUMENTS = new Set(['--records', '--labels', '--model', '--report'])
const RECORD_FILE_PATTERN = /^[a-f0-9]{64}\.json$/i

class InputError extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameName = (a, b) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!ARGUMENTS.has(name) || Object.hasOwn(options, name)
      || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new InputError('invalid_arguments')
    }
    options[name] = resolve(value)
  }
  if (!options['--records'] || !options['--labels'] || !options['--model']) {
    throw new InputError('invalid_arguments')
  }
  return {
    records: options['--records'], labels: options['--labels'],
    model: options['--model'], report: options['--report'] ?? null,
  }
}

function existingStat(path) {
  try { return lstatSync(path) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function canonicalInput(path) {
  try { return realpathSync(path) } catch { return path }
}

function canonicalOutput(path) {
  try {
    const stat = existingStat(path)
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) return null
    const parent = realpathSync(dirname(path))
    if (!statSync(parent).isDirectory()) return null
    return { path: stat ? realpathSync(path) : join(parent, basename(path)), stat }
  } catch { return null }
}

function isPriorAggregateReport(path) {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) return false
    const report = JSON.parse(readBoundedLabels(path))
    const keys = [
      'status', 'eligible', 'reasons', 'labeledTurns', 'trainingTurns', 'holdoutTurns',
      'trainingSessions', 'holdoutSessions', 'classCounts', 'metrics', 'modelWritten',
    ]
    if (!isObject(report) || !keys.every(key => Object.hasOwn(report, key))
      || Object.keys(report).length !== keys.length + Number(Object.hasOwn(report, 'existingModelRetained'))
      || !['eligible', 'ineligible'].includes(report.status)
      || report.eligible !== (report.status === 'eligible')
      || !Array.isArray(report.reasons) || report.reasons.length > 16
      || report.reasons.some(reason => typeof reason !== 'string' || !/^[a-z0-9_]+$/.test(reason))
      || !['labeledTurns', 'trainingTurns', 'holdoutTurns', 'trainingSessions', 'holdoutSessions']
        .every(key => Number.isSafeInteger(report[key]) && report[key] >= 0)
      || typeof report.modelWritten !== 'boolean'
      || (Object.hasOwn(report, 'existingModelRetained')
        && report.existingModelRetained !== null
        && typeof report.existingModelRetained !== 'boolean')
      || !isObject(report.classCounts)
      || Object.keys(report.classCounts).length !== 2
      || !['training', 'holdout'].every(part => isObject(report.classCounts[part])
        && Object.keys(report.classCounts[part]).length === 2
        && ['success', 'failure'].every(label => Number.isSafeInteger(report.classCounts[part][label])
          && report.classCounts[part][label] >= 0))) return false
    if (report.metrics === null) return true
    return isObject(report.metrics) && isObject(report.metrics.model)
      && isObject(report.metrics.baseline)
      && Object.keys(report.metrics).length === 2
      && Object.keys(report.metrics.model).length === 3
      && Object.keys(report.metrics.baseline).length === 2
      && ['brier', 'logLoss', 'ece5'].every(key => typeof report.metrics.model[key] === 'number'
        && Number.isFinite(report.metrics.model[key]) && report.metrics.model[key] >= 0)
      && ['brier', 'logLoss'].every(key => typeof report.metrics.baseline[key] === 'number'
        && Number.isFinite(report.metrics.baseline[key]) && report.metrics.baseline[key] >= 0)
  } catch { return false }
}

function selectedOutput(path, kind) {
  if (extname(path).toLowerCase() !== '.json') return null
  const output = canonicalOutput(path)
  if (!output || !output.stat) return output
  if (kind === 'model') return loadTurnRiskModel(output.path).status === 'ready' ? output : null
  return isPriorAggregateReport(output.path) ? output : null
}

function isWithin(parent, candidate) {
  const base = process.platform === 'win32' ? parent.toLowerCase() : parent
  const target = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const remainder = relative(base, target)
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`)
    && !isAbsolute(remainder))
}

function sameExistingFile(a, b) {
  if (!a || !b) return false
  return a.dev === b.dev && a.ino === b.ino
}

function inspectOutputPaths(paths) {
  const records = canonicalInput(paths.records)
  const labels = canonicalInput(paths.labels)
  const labelStat = existingStat(paths.labels)
  const model = selectedOutput(paths.model, 'model')
  const report = paths.report === null ? null : selectedOutput(paths.report, 'report')
  const recordFile = output => isWithin(records, output.path)
    && RECORD_FILE_PATTERN.test(relative(records, output.path))
  const reportSafe = report !== null && !sameName(report.path, labels)
    && !sameExistingFile(report.stat, labelStat) && !recordFile(report)
  const modelSafe = model !== null && !sameName(model.path, labels)
    && !sameExistingFile(model.stat, labelStat) && !recordFile(model)
  const distinct = !report || !model || (!sameName(report.path, model.path)
    && !sameExistingFile(report.stat, model.stat))
  return {
    safe: modelSafe && (paths.report === null || reportSafe) && distinct,
    modelPath: modelSafe && distinct ? model.path : null,
    reportPath: reportSafe && distinct ? report.path : null,
  }
}

function readBoundedLabels(path) {
  let fd
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1
      || before.size > MAX_LABEL_BYTES) throw new InputError('invalid_labels')
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size !== before.size
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new InputError('invalid_labels')
    }
    const buffer = Buffer.alloc(opened.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (count === 0) break
      length += count
    }
    if (length !== opened.size) throw new InputError('invalid_labels')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError(error?.code === 'ENOENT' ? 'missing_labels' : 'invalid_labels')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function parseLabels(content) {
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (lines.length === 0 || lines.length > MAX_LABEL_LINES) {
    throw new InputError('invalid_labels')
  }
  const labels = []
  const seen = new Map()
  for (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LABEL_LINE_BYTES) throw new InputError('invalid_labels')
    let raw
    try { raw = JSON.parse(line) } catch { throw new InputError('invalid_labels') }
    const completedAt = normalizeCompletedAt(raw?.completedAt)
    if (!isObject(raw) || Object.keys(raw).length !== 4
      || !['sessionId', 'turn', 'outcome', 'completedAt'].every(key => Object.hasOwn(raw, key))
      || typeof raw.sessionId !== 'string' || raw.sessionId.length === 0
      || raw.sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(raw.sessionId)
      || !Number.isSafeInteger(raw.turn) || raw.turn < 0
      || !['success', 'failure'].includes(raw.outcome)
      || completedAt === null) {
      throw new InputError('invalid_labels')
    }
    const label = {
      sessionId: raw.sessionId, turn: raw.turn, outcome: raw.outcome,
      completedAt,
    }
    const key = label.sessionId + '\u0000' + label.turn
    if (seen.has(key)) {
      const earlier = seen.get(key)
      throw new InputError(earlier.outcome === label.outcome
        && earlier.completedAt === label.completedAt ? 'duplicate_labels' : 'conflicting_labels')
    }
    seen.set(key, label)
    labels.push(label)
  }
  return labels
}

function matchRecords(recordsPath, labels) {
  let store
  let available
  try {
    if (!statSync(recordsPath).isDirectory()) throw new InputError('missing_records')
    store = createStore({ dataDir: recordsPath, maxSessions: 1000, maxStepsPerSession: 1000 })
    available = new Set(store.read().sessions.map(session => session.sessionId))
  } catch { throw new InputError('missing_records') }
  const sessionSteps = new Map()
  const turns = []
  for (const label of labels) {
    if (!available.has(label.sessionId)) throw new InputError('missing_records')
    if (!sessionSteps.has(label.sessionId)) {
      try { sessionSteps.set(label.sessionId, store.read(label.sessionId).steps) }
      catch { throw new InputError('missing_records') }
    }
    const steps = sessionSteps.get(label.sessionId).filter(row => row.turn === label.turn)
    if (steps.length === 0) throw new InputError('missing_records')
    if (steps.some(row => Date.parse(row.observedAt) > Date.parse(label.completedAt))) {
      throw new InputError('invalid_labels')
    }
    turns.push({ ...label, steps })
  }
  return turns
}

function failureReport(reason, labeledTurns = 0, existingModelRetained = null) {
  return {
    status: 'ineligible', eligible: false, reasons: [reason], labeledTurns,
    trainingTurns: 0, holdoutTurns: 0, trainingSessions: 0, holdoutSessions: 0,
    classCounts: {
      training: { success: 0, failure: 0 }, holdout: { success: 0, failure: 0 },
    },
    metrics: null, modelWritten: false, existingModelRetained,
  }
}

function writeJsonAtomically(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* The temporary file may not exist. */ }
    throw error
  }
}

function emit(report, reportPath) {
  let output = report
  let reportWriteFailed = false
  if (reportPath !== null) {
    try { writeJsonAtomically(reportPath, report) }
    catch {
      reportWriteFailed = true
      output = { ...report, reportWriteFailed: true,
        reasons: [...report.reasons, 'report_write_failed'] }
    }
  }
  process.stdout.write(JSON.stringify(output) + '\n')
  process.exitCode = !reportWriteFailed && output.eligible && output.modelWritten ? 0 : 1
}

let paths
let reportPath = null
let safeModelPath = null
let labeledTurns = 0
try {
  paths = parseArguments(process.argv.slice(2))
  const safety = inspectOutputPaths(paths)
  reportPath = safety.reportPath
  if (!safety.safe) throw new InputError('unsafe_output_path')
  safeModelPath = safety.modelPath
  const labels = parseLabels(readBoundedLabels(paths.labels))
  labeledTurns = labels.length
  const result = trainTurnRiskModel(matchRecords(paths.records, labels))
  const report = { ...result.report, modelWritten: false, existingModelRetained: false }
  if (result.eligible) {
    try {
      writeJsonAtomically(safeModelPath, result.model)
      report.modelWritten = true
    } catch { throw new InputError('model_write_failed') }
  } else {
    report.existingModelRetained = loadTurnRiskModel(safeModelPath).status === 'ready'
  }
  emit(report, reportPath)
} catch (error) {
  const reason = error instanceof InputError ? error.reason : 'training_failed'
  const existingModelRetained = safeModelPath === null ? null
    : loadTurnRiskModel(safeModelPath).status === 'ready'
  emit(failureReport(reason, labeledTurns, existingModelRetained), reportPath)
}
