import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { estimateStepFailure } from './step-probability.js'

const SCHEMA_VERSION = 1
const PLUGIN_VERSION = '0.3.0'
const READABLE_PLUGIN_VERSIONS = new Set(['0.2.0', PLUGIN_VERSION])
const CALIBRATION = 'experimental_uncalibrated'
const FILE_PATTERN = /^[a-f0-9]{64}\.json$/
const MAX_DIRECTORY_ENTRIES = 4096
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_LOAD_BYTES = 256 * 1024 * 1024
const MAX_SAVED_STEPS = 1000
const ROLES = new Set(['planner', 'executor', 'verifier', 'other'])
const OUTCOMES = new Set(['success', 'error', 'unknown'])
const OPERATIONS = new Set(['action', 'read', 'verification', 'unknown'])
const EVIDENCE_CODES = new Set([
  'no_hard_signal', 'tool_error', 'request_error', 'agent_error', 'interrupted', 'model_attempt',
])

const invalid = field => { throw new TypeError('invalid ' + field) }
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fileName = sessionId => createHash('sha256').update(sessionId).digest('hex') + '.json'
const positionCompare = (a, b) => a.turn - b.turn || a.step - b.step
const sessionCompare = (a, b) => b.updatedAt.localeCompare(a.updatedAt)
  || b.sessionId.localeCompare(a.sessionId)

function sessionIdentity(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)) invalid('sessionId')
  return value
}

function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field)
  return value
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)))
    invalid('observedAt')
  return new Date(value).toISOString()
}

function stringList(value, field, allowed, limit) {
  if (!Array.isArray(value) || value.length > limit
    || value.some(item => typeof item !== 'string' || !allowed(item))) invalid(field)
  return [...new Set(value)]
}

// Rebuild all prose from the bundled rules model. JSON on disk is not a source of
// UI instructions, arbitrary model text, or executable links.
function safeEstimate(value, facts) {
  const expected = estimateStepFailure(facts)
  if (!isObject(value) || value.modelVersion !== expected.modelVersion
    || value.status !== expected.status || value.source !== 'rules'
    || value.evidenceQuality !== expected.evidenceQuality || !isObject(value.factors))
    invalid('stepFailure')
  for (const factor of ['problem', 'persistence', 'impact']) {
    if (value.factors[factor] !== expected.factors[factor]) invalid('stepFailure factors')
  }
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)
    || Math.abs(value.value - expected.value) > 1e-12) invalid('stepFailure value')
  return expected
}

export function normalizeSnapshot(input) {
  if (!isObject(input)) invalid('snapshot')
  if (!ROLES.has(input.role)) invalid('role')
  if (!OUTCOMES.has(input.outcome)) invalid('outcome')
  if (!OPERATIONS.has(input.operation)) invalid('operation')
  const safe = {
    sessionId: sessionIdentity(input.sessionId),
    turn: integer(input.turn, 'turn'),
    step: integer(input.step, 'step'),
    ordinal: integer(input.ordinal, 'ordinal'),
    revision: integer(input.revision, 'revision'),
    observedAt: timestamp(input.observedAt),
    role: input.role,
    delegationDepth: integer(input.delegationDepth, 'delegationDepth'),
    toolNames: stringList(input.toolNames, 'toolNames', name => /^[A-Za-z0-9_.:/-]{1,128}$/.test(name), 128),
    toolCount: integer(input.toolCount, 'toolCount'),
    outcome: input.outcome,
    operation: input.operation,
    evidenceCodes: stringList(input.evidenceCodes, 'evidenceCodes', code => EVIDENCE_CODES.has(code), 32),
  }
  safe.stepFailure = safeEstimate(input.stepFailure, safe)
  return safe
}

function sessionRecord(sessionId, steps, maxStepsPerSession) {
  const unique = new Map()
  for (const step of steps) {
    if (step.sessionId !== sessionId) continue
    const key = `${step.turn}:${step.step}`
    const previous = unique.get(key)
    if (!previous || step.revision > previous.revision) unique.set(key, step)
  }
  const kept = [...unique.values()].sort(positionCompare).slice(-maxStepsPerSession)
  if (kept.length === 0) return null
  return {
    sessionId,
    updatedAt: kept.reduce((latest, step) => step.observedAt > latest ? step.observedAt : latest, ''),
    steps: kept,
  }
}

export function createStore({ dataDir = null, maxSessions = 100, maxStepsPerSession = 500 } = {}) {
  for (const [name, value, max] of [
    ['maxSessions', maxSessions, 1000], ['maxStepsPerSession', maxStepsPerSession, MAX_SAVED_STEPS],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(name + ' must be an integer in [1, ' + max + ']')
  }
  if (dataDir !== null && (typeof dataDir !== 'string' || dataDir.length === 0)) invalid('dataDir')
  const directory = dataDir === null ? null : resolve(dataDir)
  const sessions = new Map()
  const diskFiles = new Set()
  let loaded = false

  function load() {
    if (loaded) return
    if (directory === null) { loaded = true; return }
    let handle
    try { handle = opendirSync(directory) } catch (error) {
      if (error.code === 'ENOENT') { loaded = true; return }
      throw error
    }
    const candidates = []
    try {
      for (let index = 0; index < MAX_DIRECTORY_ENTRIES; index += 1) {
        const entry = handle.readSync()
        if (!entry) break
        if (!entry.isFile() || !FILE_PATTERN.test(entry.name)) continue
        try {
          const path = join(directory, entry.name)
          const stat = lstatSync(path)
          if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES) {
            candidates.push({ path, name: entry.name, size: stat.size, mtime: stat.mtimeMs,
              dev: stat.dev, ino: stat.ino })
            diskFiles.add(entry.name)
          }
        } catch { /* A concurrently removed or unreadable record is unavailable. */ }
      }
    } finally { handle.closeSync() }
    candidates.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    let bytesRead = 0
    for (const candidate of candidates) {
      if (sessions.size >= maxSessions) break
      if (bytesRead + candidate.size > MAX_LOAD_BYTES) continue
      bytesRead += candidate.size
      let fd
      try {
        // Verify the opened object as well as its directory entry before reading.
        fd = openSync(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size !== candidate.size
          || stat.dev !== candidate.dev || stat.ino !== candidate.ino) continue
        // Read into a fixed-size buffer: concurrent growth cannot enlarge this read.
        const buffer = Buffer.alloc(stat.size + 1)
        let length = 0
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, length)
          if (count === 0) break
          length += count
        }
        if (length !== stat.size) continue
        const raw = JSON.parse(buffer.toString('utf8', 0, length))
        if (!isObject(raw) || raw.schemaVersion !== SCHEMA_VERSION
          || !READABLE_PLUGIN_VERSIONS.has(raw.pluginVersion) || raw.calibration !== CALIBRATION
          || !Array.isArray(raw.steps) || raw.steps.length > MAX_SAVED_STEPS) continue
        const id = sessionIdentity(raw.sessionId)
        if (fileName(id) !== candidate.name) continue
        const safeSteps = []
        for (const row of raw.steps) {
          try { safeSteps.push(normalizeSnapshot(row)) } catch { /* Invalid rows are unavailable. */ }
        }
        const record = sessionRecord(id, safeSteps, maxStepsPerSession)
        if (record) sessions.set(id, record)
      } catch { /* Corrupt records never interrupt the host or reach the viewer. */ }
      finally { if (fd !== undefined) closeSync(fd) }
    }
    loaded = true
  }

  function persist(record) {
    if (directory === null) return
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, fileName(record.sessionId))
    const temporary = join(directory, fileName(record.sessionId) + '.' + randomUUID() + '.tmp')
    const content = JSON.stringify({
      schemaVersion: SCHEMA_VERSION, pluginVersion: PLUGIN_VERSION, calibration: CALIBRATION, ...record,
    })
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new RangeError('session record exceeds size limit')
    let fd
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, path)
      diskFiles.add(fileName(record.sessionId))
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch { /* No temporary file may have been created. */ }
      throw error
    }
  }

  function put(input) {
    const safe = normalizeSnapshot(input)
    load()
    const previous = sessions.get(safe.sessionId)
    const same = previous?.steps.find(row => positionCompare(row, safe) === 0)
    if (same && safe.revision <= same.revision) return structuredClone(same)
    // A revision cannot move the original step in its session's sequence.
    if (same) safe.ordinal = same.ordinal
    const rows = (previous?.steps ?? []).filter(row => positionCompare(row, safe) !== 0)
    const record = sessionRecord(safe.sessionId, [...rows, safe], maxStepsPerSession)
    persist(record)
    sessions.set(safe.sessionId, record)
    const stale = [...sessions.values()].sort(sessionCompare).slice(maxSessions)
    for (const old of stale) sessions.delete(old.sessionId)
    if (directory !== null) {
      const keep = new Set([...sessions.keys()].map(fileName))
      for (const name of diskFiles) {
        if (keep.has(name)) continue
        // Only this store's hashed JSON namespace is subject to retention.
        try { unlinkSync(join(directory, name)); diskFiles.delete(name) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
    return structuredClone(safe)
  }

  function read(sessionId) {
    if (sessionId !== undefined && sessionId !== null) sessionIdentity(sessionId)
    load()
    const ordered = [...sessions.values()].sort(sessionCompare)
    const selected = sessionId ?? ordered[0]?.sessionId ?? null
    const record = selected === null ? null : sessions.get(selected)
    return {
      schemaVersion: SCHEMA_VERSION, pluginVersion: PLUGIN_VERSION, calibration: CALIBRATION,
      sessionId: selected,
      sessions: ordered.map(item => ({ sessionId: item.sessionId, updatedAt: item.updatedAt, stepCount: item.steps.length })),
      steps: structuredClone(record?.steps ?? []),
      updatedAt: record?.updatedAt ?? null,
    }
  }

  return { put, read, clearMemory() { sessions.clear(); diskFiles.clear(); loaded = false } }
}
