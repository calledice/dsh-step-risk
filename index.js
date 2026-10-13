import { appendFileSync } from 'node:fs'
import { createFeatureCollector, validateRoleMap } from './src/features.js'
import { createTracker, normalizeModelConfig } from './src/tracker.js'
import { estimateStepFailure } from './src/step-probability.js'
import { createStore } from './src/store.js'
import { registerSnapshotRoute } from './src/routes.js'
import { isAbsolute } from 'node:path'

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
  for (const [key, value] of Object.entries({ maxSessions, maxStepsPerSession }))
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
      throw new RangeError(key + ' must be an integer in [1, 1000]')
  return { ...model, logToConsole, logFile, roleByPreset, dataDir, maxSessions, maxStepsPerSession }
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
  registerSnapshotRoute(ctx, store)

  function publish(snapshot) {
    latest.delete(snapshot.sessionId)
    latest.set(snapshot.sessionId, snapshot)
    if (latest.size > config.maxSessions) {
      const oldest = latest.keys().next().value
      latest.delete(oldest)
      ordinalBases.delete(oldest)
      tracker.forgetSession(oldest)
      collector.forgetSession(oldest)
    }
    try { store.put(snapshot) } catch (error) { reportInternalFailure('store write', error) }
    const line = JSON.stringify(snapshot)
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
        ctx.emit('step-risk/prediction', snapshot)
      } catch (error) {
        reportInternalFailure('prediction event', error)
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      const observation = collector.observeSessionEvent(session, event)
      if (!observation) return
      const { sessionId, ...stepObservation } = observation
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
      ordinalBases.delete(session.id)
    } catch (error) {
      reportInternalFailure('session disposal', error)
    }
  })
}
