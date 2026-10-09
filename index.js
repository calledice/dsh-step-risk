import { appendFileSync } from 'node:fs'
import { createFeatureCollector, validateRoleMap } from './src/features.js'
import { createTracker, normalizeModelConfig } from './src/tracker.js'

export const name = 'dsh-step-risk'

export function normalizePluginConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('plugin config must be an object')
  }
  const model = normalizeModelConfig(raw)
  const logToConsole = raw.logToConsole ?? true
  const logFile = raw.logFile ?? null
  const roleByPreset = raw.roleByPreset ?? {}
  if (typeof logToConsole !== 'boolean') {
    throw new TypeError('logToConsole must be a boolean')
  }
  if (logFile !== null && (typeof logFile !== 'string' || logFile.length === 0 || logFile.includes('\0'))) {
    throw new TypeError('logFile must be null or a non-empty path')
  }
  validateRoleMap(roleByPreset)
  return { ...model, logToConsole, logFile, roleByPreset }
}

export function apply(ctx, rawConfig = {}) {
  if (!ctx || typeof ctx.on !== 'function') {
    throw new TypeError('Cordis context must provide on')
  }
  const config = normalizePluginConfig(rawConfig)
  const tracker = createTracker(config)
  const collector = createFeatureCollector(config.roleByPreset)

  function reportInternalFailure(stage, error) {
    const kind = error instanceof Error ? error.name : 'UnknownError'
    console.error('[dsh-step-risk] ' + stage + ' failed (' + kind + ')')
  }

  function publish(snapshot) {
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
      publish(tracker.observeStep(sessionId, stepObservation))
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
      if (update) publish(update)
      else collector.observeAgentError(payload)
    } catch (error) {
      reportInternalFailure('agent error observation', error)
    }
  })

  ctx.on('session/disposed', session => {
    try {
      collector.forgetSession(session.id)
      tracker.forgetSession(session.id)
    } catch (error) {
      reportInternalFailure('session disposal', error)
    }
  })
}
