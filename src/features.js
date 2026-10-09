const VALID_ROLES = new Set(['planner', 'executor', 'verifier', 'other'])

export function inferRole(agentPreset, roleByPreset = {}) {
  if (typeof agentPreset !== 'string' || agentPreset.length === 0) return 'other'
  if (Object.prototype.hasOwnProperty.call(roleByPreset, agentPreset)) {
    return roleByPreset[agentPreset]
  }
  const name = agentPreset.toLowerCase()
  if (['planner', 'planning', 'orchestrator', 'coordinator'].some(part => name.includes(part))) {
    return 'planner'
  }
  if (['verifier', 'verification', 'reviewer', 'auditor'].some(part => name.includes(part))) {
    return 'verifier'
  }
  if (['executor', 'browser', 'web', 'coder', 'coding', 'operator', 'tool'].some(part => name.includes(part))) {
    return 'executor'
  }
  return 'other'
}

export function validateRoleMap(roleByPreset) {
  if (roleByPreset === null || typeof roleByPreset !== 'object' || Array.isArray(roleByPreset)) {
    throw new TypeError('roleByPreset must be an object')
  }
  for (const [preset, role] of Object.entries(roleByPreset)) {
    if (preset.length === 0 || !VALID_ROLES.has(role)) {
      throw new RangeError('roleByPreset contains an invalid preset or role')
    }
  }
}

export function createFeatureCollector(roleByPreset = {}) {
  validateRoleMap(roleByPreset)
  const pending = new Map()
  const key = (sessionId, turn, step) => JSON.stringify([sessionId, turn, step])

  function addEvidence(sessionId, turn, step, code) {
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return
    const id = key(sessionId, turn, step)
    let codes = pending.get(id)
    if (!codes) {
      codes = new Set()
      pending.set(id, codes)
    }
    if (code) codes.add(code)
  }

  function observeSessionEvent(session, event) {
    const sessionId = session?.id
    const { turn, step } = event?.data ?? {}
    if (event?.type === 'step/start') {
      addEvidence(sessionId, turn, step, null)
      return null
    }
    if (event?.type === 'tool/result' && event.data.message?.isError === true) {
      addEvidence(sessionId, turn, step, 'tool_error')
      return null
    }
    if (event?.type === 'assistant/message' && event.data.interrupted === true) {
      addEvidence(sessionId, turn, step, 'interrupted')
      return null
    }
    if (event?.type === 'assistant/attempt') {
      addEvidence(sessionId, turn, step, 'model_attempt')
      return null
    }
    if (event?.type !== 'step/end') return null
    const id = key(sessionId, turn, step)
    const evidenceCodes = [...(pending.get(id) ?? [])]
    pending.delete(id)
    const depth = session.header?.delegationDepth
    return {
      sessionId,
      turn,
      step,
      role: inferRole(session.header?.agentPreset, roleByPreset),
      delegationDepth: Number.isSafeInteger(depth) && depth >= 0 ? depth : 0,
      evidenceCodes,
    }
  }

  function observeRequestError(payload) {
    addEvidence(payload?.agent?.session?.id, payload?.turn, payload?.step, 'request_error')
  }

  function observeAgentError(payload) {
    addEvidence(payload?.agent?.session?.id, payload?.turn, payload?.step, 'agent_error')
  }

  function forgetSession(sessionId) {
    for (const id of pending.keys()) {
      if (id.startsWith(JSON.stringify([sessionId]).slice(0, -1) + ',')) {
        pending.delete(id)
      }
    }
  }

  return { observeSessionEvent, observeRequestError, observeAgentError, forgetSession }
}
