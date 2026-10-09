export const MODEL_VERSION = '0.1.0'
export const CALIBRATION = 'experimental_uncalibrated'

export const DEFAULT_MODEL_CONFIG = Object.freeze({
  baseHazard: 0.03,
  recoveryHazard: 0.02,
  roleOffsets: Object.freeze({
    planner: 0.15,
    executor: 0.2,
    verifier: 0,
    other: 0,
  }),
  delegationDepthOffset: 0.08,
  likelihoodRatios: Object.freeze({
    no_hard_signal: 0.25,
    tool_error: 6,
    request_error: 2.5,
    agent_error: 8,
    interrupted: 2,
    model_attempt: 1.3,
  }),
  maxCandidates: 128,
  topK: 3,
})

const ROLES = new Set(['planner', 'executor', 'verifier', 'other'])
const EVIDENCE_CODES = new Set(Object.keys(DEFAULT_MODEL_CONFIG.likelihoodRatios))

function validateMap(name, value, allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(name + ' must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new RangeError(name + ' contains unknown key: ' + key)
  }
}

function assertFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(name + ' must be a finite number')
  }
}

function logAddExp(a, b) {
  if (a === -Infinity) return b
  if (b === -Infinity) return a
  const high = Math.max(a, b)
  return high + Math.log1p(Math.exp(Math.min(a, b) - high))
}

function logSumExp(values) {
  let result = -Infinity
  for (const value of values) result = logAddExp(result, value)
  return result
}

function sigmoid(value) {
  const bounded = Math.max(-30, Math.min(30, value))
  return 1 / (1 + Math.exp(-bounded))
}

export function normalizeModelConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('model config must be an object')
  }
  if (raw.roleOffsets !== undefined) validateMap('roleOffsets', raw.roleOffsets, ROLES)
  if (raw.likelihoodRatios !== undefined) validateMap('likelihoodRatios', raw.likelihoodRatios, EVIDENCE_CODES)
  const config = {
    baseHazard: raw.baseHazard ?? DEFAULT_MODEL_CONFIG.baseHazard,
    recoveryHazard: raw.recoveryHazard ?? DEFAULT_MODEL_CONFIG.recoveryHazard,
    roleOffsets: { ...DEFAULT_MODEL_CONFIG.roleOffsets, ...raw.roleOffsets },
    delegationDepthOffset: raw.delegationDepthOffset ?? DEFAULT_MODEL_CONFIG.delegationDepthOffset,
    likelihoodRatios: { ...DEFAULT_MODEL_CONFIG.likelihoodRatios, ...raw.likelihoodRatios },
    maxCandidates: raw.maxCandidates ?? DEFAULT_MODEL_CONFIG.maxCandidates,
    topK: raw.topK ?? DEFAULT_MODEL_CONFIG.topK,
  }
  assertFinite('baseHazard', config.baseHazard)
  if (config.baseHazard <= 0 || config.baseHazard >= 1) {
    throw new RangeError('baseHazard must be between 0 and 1')
  }
  assertFinite('recoveryHazard', config.recoveryHazard)
  if (config.recoveryHazard < 0 || config.recoveryHazard >= 1) {
    throw new RangeError('recoveryHazard must be in [0, 1)')
  }
  for (const role of ROLES) {
    assertFinite('roleOffsets.' + role, config.roleOffsets[role])
    if (Math.abs(config.roleOffsets[role]) > 10) {
      throw new RangeError('roleOffsets.' + role + ' must be within [-10, 10]')
    }
  }
  assertFinite('delegationDepthOffset', config.delegationDepthOffset)
  if (Math.abs(config.delegationDepthOffset) > 10) {
    throw new RangeError('delegationDepthOffset must be within [-10, 10]')
  }
  for (const [code, value] of Object.entries(config.likelihoodRatios)) {
    assertFinite('likelihoodRatios.' + code, value)
    if (value <= 0 || value > 1_000_000) {
      throw new RangeError('likelihoodRatios.' + code + ' must be in (0, 1000000]')
    }
  }
  if (!Number.isSafeInteger(config.maxCandidates) || config.maxCandidates < 1 || config.maxCandidates > 100_000) {
    throw new RangeError('maxCandidates must be an integer in [1, 100000]')
  }
  if (!Number.isSafeInteger(config.topK) || config.topK < 1 || config.topK > config.maxCandidates) {
    throw new RangeError('topK must be an integer in [1, maxCandidates]')
  }
  return config
}

function validateObservation(observation, config) {
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new TypeError('step observation must be an object')
  }
  for (const field of ['turn', 'step']) {
    if (!Number.isSafeInteger(observation[field]) || observation[field] < 0) {
      throw new RangeError(field + ' must be a non-negative safe integer')
    }
  }
  if (!ROLES.has(observation.role)) {
    throw new RangeError('role must be planner, executor, verifier, or other')
  }
  if (!Number.isSafeInteger(observation.delegationDepth) || observation.delegationDepth < 0) {
    throw new RangeError('delegationDepth must be a non-negative safe integer')
  }
  if (!Array.isArray(observation.evidenceCodes)) {
    throw new TypeError('evidenceCodes must be an array')
  }
  for (const code of observation.evidenceCodes) {
    if (typeof code !== 'string' || !Object.hasOwn(config.likelihoodRatios, code)) {
      throw new RangeError('unknown evidence code: ' + String(code))
    }
  }
}

function positionCompare(a, b) {
  return a.turn === b.turn ? a.step - b.step : a.turn - b.turn
}

function buildSnapshot(sessionId, state, current, config) {
  const normalizer = logSumExp([
    state.logFuture,
    state.logOtherPast,
    ...state.candidates.map(candidate => candidate.logWeight),
  ])
  const probability = logWeight => logWeight === -Infinity ? 0 : Math.exp(logWeight - normalizer)
  const retained = state.candidates.reduce((sum, candidate) => sum + probability(candidate.logWeight), 0)
  const topCandidates = [...state.candidates]
    .sort((a, b) => b.logWeight - a.logWeight)
    .slice(0, config.topK)
    .map(candidate => ({
      turn: candidate.turn,
      step: candidate.step,
      role: candidate.role,
      probability: probability(candidate.logWeight),
    }))
  return {
    modelVersion: MODEL_VERSION,
    calibration: CALIBRATION,
    scope: 'conditional_on_eventual_failure_and_responsibility_in_session',
    sessionId,
    turn: current.turn,
    step: current.step,
    ordinal: state.ordinal,
    revision: state.revision,
    role: current.role,
    delegationDepth: current.delegationDepth,
    evidenceCodes: [...current.evidenceCodes],
    priorHazard: current.priorHazard,
    pCurrent: probability(current.logWeight),
    pCurrentGivenNoEarlier: Math.exp(current.logWeight - logSumExp([current.logWeight, state.logFuture])),
    pRetained: retained,
    pOtherPast: probability(state.logOtherPast),
    pFuture: probability(state.logFuture),
    retainedCandidates: state.candidates.length,
    topCandidates,
    unattributed: 'not_modeled',
  }
}

export function createTracker(rawConfig = {}) {
  const config = normalizeModelConfig(rawConfig)
  const sessions = new Map()

  function observeStep(sessionId, observation) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('sessionId must be a non-empty string')
    }
    validateObservation(observation, config)
    let state = sessions.get(sessionId)
    if (!state) {
      state = {
        logFuture: 0,
        logOtherPast: -Infinity,
        candidates: [],
        ordinal: 0,
        revision: 0,
        lastPosition: null,
        lastSnapshot: null,
      }
      sessions.set(sessionId, state)
    }
    const position = { turn: observation.turn, step: observation.step }
    if (state.lastPosition) {
      const comparison = positionCompare(position, state.lastPosition)
      if (comparison === 0) return state.lastSnapshot
      if (comparison < 0) throw new RangeError('step observations must arrive in order')
    }
    if (state.ordinal > 0 && config.recoveryHazard > 0) {
      const logPast = logSumExp([
        state.logOtherPast,
        ...state.candidates.map(candidate => candidate.logWeight),
      ])
      state.logFuture = logAddExp(
        state.logFuture,
        logPast + Math.log(config.recoveryHazard),
      )
      const logSurvival = Math.log1p(-config.recoveryHazard)
      state.logOtherPast += logSurvival
      for (const candidate of state.candidates) candidate.logWeight += logSurvival
    }
    const logit = Math.log(config.baseHazard / (1 - config.baseHazard))
      + config.roleOffsets[observation.role]
      + config.delegationDepthOffset * observation.delegationDepth
    const hazard = sigmoid(logit)
    const evidenceCodes = [...new Set(observation.evidenceCodes)]
    if (evidenceCodes.length === 0) evidenceCodes.push('no_hard_signal')
    const logEvidence = evidenceCodes.reduce(
      (sum, code) => sum + Math.log(config.likelihoodRatios[code]),
      0,
    )
    const current = {
      ...position,
      role: observation.role,
      delegationDepth: observation.delegationDepth,
      evidenceCodes,
      priorHazard: hazard,
      logWeight: state.logFuture + Math.log(hazard) + logEvidence,
    }
    state.logFuture += Math.log1p(-hazard)
    state.candidates.push(current)
    state.ordinal += 1
    state.revision = 0
    state.lastPosition = position
    if (state.candidates.length > config.maxCandidates) {
      let smallestIndex = 0
      for (let index = 1; index < state.candidates.length - 1; index += 1) {
        if (state.candidates[index].logWeight < state.candidates[smallestIndex].logWeight) {
          smallestIndex = index
        }
      }
      const [removed] = state.candidates.splice(smallestIndex, 1)
      state.logOtherPast = logAddExp(state.logOtherPast, removed.logWeight)
    }
    state.lastSnapshot = buildSnapshot(sessionId, state, current, config)
    return state.lastSnapshot
  }

  function addEvidence(sessionId, turn, step, codes) {
    const state = sessions.get(sessionId)
    if (!state || !state.lastPosition || positionCompare({ turn, step }, state.lastPosition) !== 0) {
      return null
    }
    if (!Array.isArray(codes)) throw new TypeError('evidence codes must be an array')
    const current = state.candidates.find(candidate => candidate.turn === turn && candidate.step === step)
    if (!current) return null
    const fresh = [...new Set(codes)].filter(code => !current.evidenceCodes.includes(code))
    for (const code of fresh) {
      if (typeof code !== 'string' || !Object.hasOwn(config.likelihoodRatios, code)) {
        throw new RangeError('unknown evidence code: ' + String(code))
      }
    }
    if (fresh.length === 0) return null
    if (current.evidenceCodes.includes('no_hard_signal')) {
      current.logWeight -= Math.log(config.likelihoodRatios.no_hard_signal)
      current.evidenceCodes = current.evidenceCodes.filter(code => code !== 'no_hard_signal')
    }
    for (const code of fresh) {
      current.logWeight += Math.log(config.likelihoodRatios[code])
      current.evidenceCodes.push(code)
    }
    state.revision += 1
    state.lastSnapshot = buildSnapshot(sessionId, state, current, config)
    return state.lastSnapshot
  }

  return {
    observeStep,
    addEvidence,
    getSnapshot: sessionId => sessions.get(sessionId)?.lastSnapshot ?? null,
    forgetSession: sessionId => sessions.delete(sessionId),
  }
}
