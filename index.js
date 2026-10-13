import { appendFileSync } from 'node:fs'
import { createFeatureCollector, validateRoleMap } from './src/features.js'
import { createTracker, normalizeModelConfig } from './src/tracker.js'
import { estimateStepFailure } from './src/step-probability.js'
import { createStore } from './src/store.js'
import { registerSnapshotRoute } from './src/routes.js'
import { loadTurnRiskModel, predictTurnRisk, projectTurnRisk } from './src/turn-risk.js'
import { isAbsolute, join } from 'node:path'

export const name = 'dsh-step-risk'

export function normalizePluginConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('plugin config must be an object')
  }
  const model = normalizeModelConfig(raw)
  const logToConsole = raw.logToConsole ?? false
  const logFile = raw.logFile ?? null
  const roleByPreset = raw.roleByPreset ?? {}
  const dataDir = raw.dataDir ?? null
  const maxSessions = raw.maxSessions ?? 100
  const maxStepsPerSession = raw.maxStepsPerSession ?? 500
  if (typeof logToConsole !== 'boolean') {
    throw new TypeError('logToConsole must be a boolean')
  }
  if (logFile !== null && (typeof logFile !== 'string' || logFile.length === 0 || logFile.includes('\0'))) {
    throw new TypeError('logFile must be null or a non-empty path')
  }
  validateRoleMap(roleByPreset)
  if (dataDir !== null && (typeof dataDir !== 'string' || !isAbsolute(dataDir) || dataDir.includes('\0')))
    throw new TypeError('dataDir must be null or an absolute path')
  const turnRiskModelFile = raw.turnRiskModelFile ?? (dataDir === null ? null : join(dataDir, 'turn-risk-model.json'))
  if (turnRiskModelFile !== null && (typeof turnRiskModelFile !== 'string'
    || !isAbsolute(turnRiskModelFile) || turnRiskModelFile.includes('\0')))
    throw new TypeError('turnRiskModelFile must be null or an absolute path')
  for (const [key, value] of Object.entries({ maxSessions, maxStepsPerSession }))
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
      throw new RangeError(key + ' must be an integer in [1, 1000]')
  return { ...model, logToConsole, logFile, roleByPreset, dataDir, turnRiskModelFile,
    maxSessions, maxStepsPerSession }
}

export function apply(ctx, rawConfig = {}) {
  if (!ctx || typeof ctx.on !== 'function') {
    throw new TypeError('Cordis context must provide on')
  }
  const config = normalizePluginConfig(rawConfig)
  const tracker = createTracker(config)
  const collector = createFeatureCollector(config.roleByPreset)
  const latest = new Map()
  const ordinalBases = new Map()
  const activeForecasts = new Map()
  const turnRiskModel = loadTurnRiskModel(config.turnRiskModelFile)

  function reportInternalFailure(stage, error) {
    const kind = error instanceof Error ? error.name : 'UnknownError'
    console.error('[dsh-step-risk] ' + stage + ' failed (' + kind + ')')
  }

  let store
  try {
    store = createStore(config)
  } catch (error) {
    reportInternalFailure('store initialization; using memory', error)
    store = createStore({ ...config, dataDir: null })
  }
  const projectedStore = {
    read(sessionId) {
      const record = store.read(sessionId)
      return {
        ...record,
        steps: projectTurnRisk(record.steps, turnRiskModel),
        turnRiskModel: {
          status: turnRiskModel.status,
          modelVersion: turnRiskModel.model?.modelVersion ?? null,
          validation: turnRiskModel.model?.gate ?? null,
        },
        activeTurnForecast: record.sessionId === null
          ? null : activeForecasts.get(record.sessionId) ?? null,
      }
    },
  }
  registerSnapshotRoute(ctx, projectedStore)

  function positionIsValid(sessionId, turn, step) {
    return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 512
      && Number.isSafeInteger(turn) && turn >= 0 && Number.isSafeInteger(step) && step >= 0
  }

  function observeStepStart(session, event) {
    const sessionId = session?.id
    const { turn, step } = event?.data ?? {}
    if (!positionIsValid(sessionId, turn, step)) return
    const old = activeForecasts.get(sessionId)
    if (old?.turn === turn && old?.step === step) return
    const previous = store.read(sessionId).steps
    if (previous.some(row => row.turn === turn && row.step === step)) return
    const prefix = previous.filter(row => row.turn === turn && row.step < step)
    const risk = predictTurnRisk(turnRiskModel, prefix, step)
    const forecast = { sessionId, turn, step, phase: 'pre', ...risk }
    activeForecasts.delete(sessionId)
    activeForecasts.set(sessionId, forecast)
    if (activeForecasts.size > config.maxSessions)
      activeForecasts.delete(activeForecasts.keys().next().value)
    if (typeof ctx.emit === 'function') {
      try { ctx.emit('step-risk/turn-forecast', forecast) }
      catch (error) { reportInternalFailure('turn forecast event', error) }
    }
  }

  function publish(snapshot) {
    latest.delete(snapshot.sessionId)
    latest.set(snapshot.sessionId, snapshot)
    if (latest.size > config.maxSessions) {
      const oldest = latest.keys().next().value
      latest.delete(oldest)
      activeForecasts.delete(oldest)
      ordinalBases.delete(oldest)
      tracker.forgetSession(oldest)
      collector.forgetSession(oldest)
    }
    let emitted = snapshot
    try {
      store.put(snapshot)
      const record = projectedStore.read(snapshot.sessionId)
      const current = record.steps.find(row => row.turn === snapshot.turn && row.step === snapshot.step)
      if (current) emitted = { ...snapshot, turnRisk: {
        ...current.turnRisk,
        projection: snapshot.revision > 0 ? 'at_revision' : 'at_step_end',
      } }
    } catch (error) { reportInternalFailure('store write or projection', error) }
    const line = JSON.stringify(emitted)
    if (config.logToConsole) console.log('[dsh-step-risk] ' + line)
    if (config.logFile) {
      try {
        appendFileSync(config.logFile, line + '\n', 'utf8')
      } catch (error) {
        reportInternalFailure('logFile write', error)
      }
    }
    if (typeof ctx.emit === 'function') {
      try {
        ctx.emit('step-risk/prediction', emitted)
      } catch (error) {
        reportInternalFailure('prediction event', error)
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      const observation = collector.observeSessionEvent(session, event)
      if (event?.type === 'step/start') observeStepStart(session, event)
      if (!observation) return
      const { sessionId, ...stepObservation } = observation
      const active = activeForecasts.get(sessionId)
      if (active?.turn === observation.turn && active?.step === observation.step)
        activeForecasts.delete(sessionId)
      if (!ordinalBases.has(sessionId)) {
        const oldSteps = store.read(sessionId).steps
        ordinalBases.set(sessionId, oldSteps.reduce((max, item) => Math.max(max, item.ordinal), 0))
      }
      const attribution = tracker.observeStep(sessionId, stepObservation)
      const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
      publish({ ...attribution, ...observation,
        ordinal: ordinalBases.get(sessionId) + attribution.ordinal,
        observedAt: new Date(time).toISOString(),
        stepFailure: estimateStepFailure(observation),
      })
    } catch (error) {
      reportInternalFailure('session observation', error)
    }
  })

  // This is a Harness waterfall event. Passing through next() is mandatory.
  ctx.on('agent/request-error', (payload, next) => {
    try {
      collector.observeRequestError(payload)
    } catch (error) {
      reportInternalFailure('request observation', error)
    }
    return next()
  })

  ctx.on('agent/error', payload => {
    try {
      const sessionId = payload?.agent?.session?.id
      const update = tracker.addEvidence(sessionId, payload?.turn, payload?.step, ['agent_error'])
      if (update) {
        const before = latest.get(sessionId)
        if (before) publish({ ...before, ...update, ordinal: before.ordinal,
          outcome: 'error', operation: 'unknown',
          stepFailure: estimateStepFailure({ outcome: 'error', operation: 'unknown' }),
        })
      }
      else collector.observeAgentError(payload)
    } catch (error) {
      reportInternalFailure('agent error observation', error)
    }
  })

  ctx.on('session/disposed', session => {
    try {
      collector.forgetSession(session.id)
      tracker.forgetSession(session.id)
      latest.delete(session.id)
      activeForecasts.delete(session.id)
      ordinalBases.delete(session.id)
    } catch (error) {
      reportInternalFailure('session disposal', error)
    }
  })
}
