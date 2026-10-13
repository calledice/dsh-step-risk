/** Keyless Loader/Agent/WebServer smoke against installed DSH V0.2.0-rc.2. */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.ok(process.versions.electron, 'Run through verify-dsh-runtime.cjs using Desktop Electron')
assert.ok(process.argv[2], 'Installed app.asar/dsh runtime path is required')
const runtime = resolve(process.argv[2])
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireRuntime = createRequire(join(runtime, 'package.json'))
const importRuntime = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const version = JSON.parse(readFileSync(requireRuntime.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version
assert.equal(version, '0.2.0-rc.2', 'This compatibility smoke is pinned to the requested DSH release')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-step-risk-smoke-'))
process.env.DSH_HOME = join(scratch, 'home')
process.env.DSH_AGENTS_HOME = join(scratch, 'agents')
process.env.DSH_TELEMETRY_DISABLED = '1'
const profileDir = join(process.env.DSH_HOME, 'profiles', 'step-risk-smoke')
const installedPlugin = join(profileDir, 'node_modules', 'dsh-step-risk')
const dataDir = join(profileDir, 'step-risk')
const privateMarker = 'fixture-private-prompt-and-output-must-not-be-retained'
const snapshots = []
const eventKinds = []
let application

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolResponse(id, fail) {
  const name = 'runtime_probe'
  const args = JSON.stringify({ fail, marker: privateMarker })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function jsonFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? jsonFiles(join(directory, entry.name))
    : /\.jsonl?$/.test(entry.name) ? [join(directory, entry.name)] : [])
}

try {
  mkdirSync(installedPlugin, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
  for (const file of new Set(['package.json', ...(manifest.files ?? [])])) {
    const source = resolve(project, file)
    assert.ok(source.startsWith(project + sep), 'Package files must remain inside the project')
    if (existsSync(source)) cpSync(source, join(installedPlugin, file), { recursive: true })
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-step-risk-smoke', private: true,
    dependencies: { 'dsh-step-risk': `file:${installedPlugin.replaceAll('\\', '/')}` },
    dsh: { profile: { bundles: ['dsh-step-risk'] } },
  }, null, 2))
  const rows = [
    ['llm', '@deepseek-ai/dsh-llm'],
    ['session', '@deepseek-ai/dsh-session'],
    ['session-projections', '@deepseek-ai/dsh-session-projection'],
    ['system-prompt', '@deepseek-ai/dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false }],
    ['tools', '@deepseek-ai/dsh-tools', { mode: 'native' }],
    ['agents', '@deepseek-ai/dsh-agent'],
    ['agent-loop', '@deepseek-ai/dsh-agent-loop', { agents: [] }],
    ['webserver', '@deepseek-ai/dsh-host-webserver', { host: '127.0.0.1', port: 0 }],
    ['credentials', '@deepseek-ai/dsh-credentials-local', { path: join(scratch, 'fixture-credentials.yaml'), watch: false }],
    ['connection', '@deepseek-ai/dsh-client-connection'],
  ].map(([id, name, config]) => ({ id, name, ...(config ? { config } : {}) }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), JSON.stringify([
    { insert: rows },
  ], null, 2))
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const { createLaunchEnvironmentSnapshot } = await importRuntime('@deepseek-ai/dsh-launch-environment')
  const { runProfile } = await importRuntime('@deepseek-ai/dsh/profile-boot')
  application = await runProfile({
    environment: createLaunchEnvironmentSnapshot([]),
    profile: 'step-risk-smoke', patchFiles: [], args: [],
  })
  const { ctx } = application
  assert.ok(ctx.get('loader'), 'Production Cordis Loader must remain active')
  assert.ok(ctx.get('agentLoop'), 'Production AgentLoop must be mounted')
  assert.ok(ctx.get('webServer'), 'Production WebServer must be mounted')
  assert.ok(ctx.get('connection'), 'Production authenticated Connection must be mounted')
  ctx.on('step-risk/prediction', snapshot => { snapshots.push(snapshot) })
  ctx.on('session/event', (_session, event) => { eventKinds.push(event.type) })
  const { LlmAdapter, createUserMessage } = await importRuntime('@deepseek-ai/dsh-llm')
  const { SessionId } = await importRuntime('@deepseek-ai/dsh-session')
  const { defineContentToolFixture } = await importRuntime('@deepseek-ai/dsh-tools')
  class DeterministicAdapter extends LlmAdapter {
    constructor(script) { super(); this.script = script; this.calls = 0 }
    async *stream() {
      this.calls += 1
      const response = this.script.shift()
      if (response instanceof Error) throw response
      assert.ok(response, 'Deterministic LLM fixture unexpectedly exhausted')
      yield* response
    }
  }
  const adapter = new DeterministicAdapter([
    toolResponse('smoke-success-call', false),
    toolResponse('smoke-error-call', true),
    textResponse('smoke complete'),
  ])
  ctx.get('llm').registerAdapter(['step-risk-smoke'], adapter)
  let toolExecutions = 0
  ctx.get('tools').register(defineContentToolFixture({
    name: 'runtime_probe', description: 'Deterministic local smoke fixture',
    parameters: { fail: { type: 'boolean', required: true }, marker: { type: 'string', required: true } },
    async execute({ fail }) {
      toolExecutions += 1
      if (fail) throw new Error('Expected fixture tool failure: ' + privateMarker)
      return [{ type: 'text', text: privateMarker }]
    },
  }))
  const agent = await ctx.get('agentLoop').create(SessionId('step-risk-runtime-agent'), {
    provider: 'step-risk-smoke', model: 'deterministic-fixture',
  }, { cwd: scratch })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: privateMarker }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await ctx.get('sessions').flush(agent.session)
  assert.equal(adapter.calls, 3, 'Agent must consume all three model steps')
  assert.equal(toolExecutions, 2, 'Real tool runtime must execute both success and failure')
  assert.ok(eventKinds.includes('step/end') && eventKinds.includes('tool/result'))
  assert.equal(snapshots.length, 3, 'Each real Agent step must produce one risk prediction')
  assert.equal(JSON.stringify(snapshots).includes(privateMarker), false, 'Risk output must not retain task content')
  assert.ok(snapshots.some(snapshot => JSON.stringify(snapshot).includes('tool_error')))

  const hasStepFailure = snapshots.every(snapshot => snapshot.stepFailure && typeof snapshot.stepFailure.value === 'number')
  assert.ok(hasStepFailure, 'Every real step must carry the independent stepFailure estimate')
  assert.deepEqual(snapshots.map(item => item.outcome), ['success', 'error', 'unknown'])
  const expectedValues = [0.012, 0.135, 0.045]
  snapshots.forEach((snapshot, index) => {
    assert.ok(Math.abs(snapshot.stepFailure.value - expectedValues[index]) < 1e-12,
      'Successful, failed, and unknown steps must retain their declared model estimates')
    assert.equal(snapshot.calibration, 'experimental_uncalibrated')
  })
  const persistedFiles = jsonFiles(dataDir)
  assert.ok(persistedFiles.length > 0, 'Bundle default must persist records in the isolated profile')
  const persisted = persistedFiles.map(file => readFileSync(file, 'utf8')).join('\n')
  assert.equal(persisted.includes(privateMarker), false, 'Risk persistence must not retain task content')
  const { createStore } = await import(pathToFileURL(join(installedPlugin, 'src', 'store.js')).href)
  const reloaded = createStore({ dataDir }).read(agent.session.id)
  assert.equal(reloaded.steps.length, 3, 'A fresh store must recover all three durable steps')
  assert.deepEqual(reloaded.steps.map(item => item.stepFailure.value), snapshots.map(item => item.stepFailure.value))
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  ctx.effect(() => webServer.register({
    kind: 'exact', path: '/',
    handler: (request, response) => {
      if (connection.authorizeIndex(request, response)) {
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        response.end('Authenticated fixture index')
      }
    },
  }))
  const baseUrl = `http://127.0.0.1:${webServer.port}`
  const login = await fetch(connection.authenticatedUrl(baseUrl + '/'), { redirect: 'manual' })
  assert.equal(login.status, 303, 'Native Connection token exchange must establish a browser session')
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'Native Connection must return its signed session cookie')
  const routeUrl = baseUrl + '/api/dsh-step-risk/snapshot'
  const unauthenticated = await fetch(routeUrl)
  assert.equal(unauthenticated.status, 401, 'Native Connection must reject an unauthenticated risk request')
  const untrusted = await fetch(routeUrl, { headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' } })
  assert.equal(untrusted.status, 403, 'Native Connection must enforce its Origin policy')
  const response = await fetch(routeUrl, { headers: { Cookie: cookie } })
  const routeBody = await response.text()
  assert.equal(response.status, 200, 'The authenticated native route must be mounted by the plugin')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const routeData = JSON.parse(routeBody)
  assert.equal(routeData.schemaVersion, 1)
  assert.equal(routeData.pluginVersion, manifest.version)
  assert.equal(routeData.calibration, 'experimental_uncalibrated')
  assert.equal(routeData.sessionId, agent.session.id)
  assert.deepEqual(routeData.steps, reloaded.steps, 'Native GET must expose exactly the sanitized persisted records')
  assert.equal(routeBody.includes(privateMarker), false, 'Native GET must not return raw task/output data')
  const invalidQuery = await fetch(routeUrl + '?unexpected=1', { headers: { Cookie: cookie } })
  assert.equal(invalidQuery.status, 400)
  const mutation = await fetch(routeUrl, { method: 'POST', headers: { Cookie: cookie } })
  assert.equal(mutation.status, 404, 'The native registry must not expose a POST mutation for the snapshot route')
  const report = {
    verifiedAt: new Date().toISOString(), dshVersion: version,
    electronVersion: process.versions.electron, nodeVersion: process.versions.node,
    mode: 'genuine-loader-profile-and-agent-loop-with-deterministic-llm',
    realProviderRequest: false, profileInstallation: 'isolated-copy-of-package-files',
    loader: true, realAgentLoop: true, realSessionEvents: true, realToolExecutions: toolExecutions,
    completedSteps: snapshots.length, modelCalls: adapter.calls, stepFailure: hasStepFailure,
    stepOutcomes: snapshots.map(item => item.outcome), stepFailureValues: snapshots.map(item => item.stepFailure.value),
    persistenceFiles: persistedFiles.map(file => relative(dataDir, file)),
    defaultProfileDataDirectory: true, persistenceReload: true,
    nativeConnection: true, unauthenticatedStatus: unauthenticated.status,
    untrustedOriginStatus: untrusted.status, authenticatedRouteStatus: response.status,
    authenticatedRouteJson: true, invalidQueryStatus: invalidQuery.status, mutationStatus: mutation.status,
    privacyMarkerAbsent: true, userProfileTouched: false, clientRendering: 'not-tested-by-this-script',
  }
  console.log('DSH_STEP_RISK_SMOKE=' + JSON.stringify(report))
} finally {
  if (application) await application.shutdown.shutdown(0)
  const scratchPath = resolve(scratch)
  assert.ok(dirname(scratchPath) === resolve(tmpdir()) && scratchPath.includes('dsh-step-risk-smoke-'))
  rmSync(scratchPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
