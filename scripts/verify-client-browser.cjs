#!/usr/bin/env node
/**
 * Actual Chromium/React DOM verification with a minimal DSH slot host.
 * No published runtime dependency is added. Requires an installed rc.2 Desktop,
 * Playwright, its Chromium, and React/ReactDOM 18.3.1 (the rc.2 lockfile pin).
 * Install test-only React with:
 * npm install --prefix <cache> --no-save --ignore-scripts react@18.3.1 react-dom@18.3.1
 * Then pass --react-root <cache>/node_modules. The default cache is
 * %USERPROFILE%/.cache/dsh-step-risk-browser. Other paths may be supplied with
 * --electron, --runtime-root, --playwright-root, --chromium, --report, --screenshot.
 * This verifies browser behavior, not mounting in the native DSH renderer.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } = require('node:fs')
const http = require('node:http')
const { createRequire } = require('node:module')
const { dirname, join, relative, resolve } = require('node:path')

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function runtimeInfo(runtime) {
  const runtimeRequire = createRequire(join(runtime, 'package.json'))
  const version = JSON.parse(readFileSync(runtimeRequire.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version
  assert.equal(version, '0.2.0-rc.2', 'Installed runtime must match the requested DSH version')
  return { version }
}

if (process.argv.includes('--extract-runtime')) {
  try {
    const extracted = runtimeInfo(resolve(argument('--runtime-root')))
    process.stdout.write('DSH_BROWSER_RUNTIME_INFO=' + JSON.stringify(extracted) + '\n')
  } catch (error) {
    console.error(error.stack ?? String(error))
    process.exitCode = 1
  }
} else {
  main().catch(error => { console.error(error.stack ?? String(error)); process.exitCode = 1 })
}

async function main() {
  const project = resolve(__dirname, '..')
  const executable = resolve(argument('--electron') ?? process.env.DSH_DESKTOP_EXECUTABLE
    ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'))
  const runtime = resolve(argument('--runtime-root') ?? join(dirname(executable), 'resources', 'app.asar', 'dsh'))
  const playwrightRoot = resolve(argument('--playwright-root') ?? process.env.PLAYWRIGHT_MODULE_ROOT
    ?? join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'))
  let chromiumExecutable = argument('--chromium')
  const reactRoot = resolve(argument('--react-root') ?? process.env.REACT_MODULE_ROOT
    ?? join(process.env.USERPROFILE ?? '', '.cache', 'dsh-step-risk-browser', 'node_modules'))
  const reportPath = resolve(argument('--report') ?? join(project, 'docs', 'validation-client-browser.json'))
  const screenshotPath = resolve(argument('--screenshot') ?? join(project, 'docs', 'step-risk-preview.png'))
  assert.ok(existsSync(executable), 'Installed Desktop Electron executable is required')
  assert.ok(existsSync(playwrightRoot), 'Playwright is required; pass --playwright-root <package directory>')
  const extracted = spawnSync(executable, ['--expose-internals', __filename, '--extract-runtime', '--runtime-root', runtime], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' },
  })
  if (extracted.error) throw extracted.error
  assert.equal(extracted.status, 0, extracted.stderr || 'Installed runtime version check failed')
  const line = extracted.stdout.split(/\r?\n/).find(value => value.startsWith('DSH_BROWSER_RUNTIME_INFO='))
  assert.ok(line, 'Installed runtime did not return its version information')
  const bundle = JSON.parse(line.slice('DSH_BROWSER_RUNTIME_INFO='.length))
  const reactVersion = JSON.parse(readFileSync(join(reactRoot, 'react', 'package.json'), 'utf8')).version
  const reactDomVersion = JSON.parse(readFileSync(join(reactRoot, 'react-dom', 'package.json'), 'utf8')).version
  assert.equal(reactVersion, '18.3.1', 'React must match the official rc.2 source lockfile')
  assert.equal(reactDomVersion, '18.3.1', 'ReactDOM must match the official rc.2 source lockfile')
  bundle.code = readFileSync(join(reactRoot, 'react', 'umd', 'react.development.js'), 'utf8')
    + '\n' + readFileSync(join(reactRoot, 'react-dom', 'umd', 'react-dom.development.js'), 'utf8')
  const clientSource = readFileSync(join(project, 'client.js'), 'utf8')
  const { chromium } = require(playwrightRoot)
  if (!chromiumExecutable && !existsSync(chromium.executablePath())) {
    const browserCache = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
    if (existsSync(browserCache)) {
      const candidates = readdirSync(browserCache).filter(name => /^chromium_headless_shell-\d+$/.test(name))
        .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))
        .flatMap(name => [join(browserCache, name, 'chrome-win', 'headless_shell.exe'),
          join(browserCache, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')])
      chromiumExecutable = candidates.find(existsSync)
    }
  }
  const { estimateStepFailure, operationFor } = await import('../src/step-probability.js')
  const checks = []
  const errors = []
  const requests = []
  const serverState = { fail: false, delaySession: null }
  const fixedTime = '2026-10-13T08:00:00.000Z'
  function row(sessionId, ordinal, probability, outcome, toolNames) {
    const operation = operationFor({ toolName: toolNames[0] })
    const stepFailure = estimateStepFailure({ outcome, operation })
    assert.ok(Math.abs(stepFailure.value - probability) < 1e-12, 'Fixture probability must match the production estimator')
    return {
      sessionId, turn: 1, step: ordinal, ordinal, revision: 0, observedAt: fixedTime,
      role: 'worker', delegationDepth: 0, toolNames, toolCount: toolNames.length,
      outcome, operation, evidenceCodes: outcome === 'error' ? ['tool_error'] : [], stepFailure,
    }
  }
  const records = {
    'fixture-session-a': [
      row('fixture-session-a', 1, 0.012, 'success', ['read_file']),
      row('fixture-session-a', 2, 0.135, 'error', ['runtime_probe']),
      row('fixture-session-a', 3, 0.045, 'unknown', []),
    ],
    'fixture-session-b': [row('fixture-session-b', 1, 0.012, 'success', ['session_b_read'])],
    'fixture-session-empty': [],
  }
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Step Risk browser verification</title>
<style>body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;color:#202227;background:#f5f6f8}main{display:grid;grid-template-columns:minmax(0,1fr) 420px;min-height:100vh}aside{border-left:1px solid #ddd;background:white;height:100vh;overflow:hidden}.fixture{padding:36px}button,select{padding:8px;margin:5px;font:inherit}h1{font-size:25px}.note{max-width:550px;line-height:1.8;color:#5c6470}.badge{display:inline-block;padding:6px 10px;border:1px solid #bbc6d3;border-radius:20px;color:#52657a;font-size:12px}code{font-family:Consolas,monospace;font-size:12px}</style>
<main><div class="fixture"><span class="badge">浏览器验证夹具 · 非 DSH 原生界面截图</span><h1>Step Risk 客户端渲染验证</h1><p class="note">右侧运行实际发布的 client.js，以及与 DeepSeek Harness V0.2.0-rc.2 源码锁定版本一致的 React / ReactDOM 18.3.1。会话与数据均为本地确定性测试样例。</p><div><button id="native">Native slot fixture</button><button id="settings">Settings slot fixture</button></div><label>Fixture session <select id="fixture-session" aria-label="Fixture session"><option>fixture-session-a</option><option>fixture-session-b</option><option>fixture-session-empty</option></select></label><div><button id="hide">Hide panel</button><button id="show">Show panel</button></div><p class="note">检查：概率排序、条件因子、会话隔离、无记录与请求失败状态，以及隐藏页签停止轮询。</p><code>数据来源：确定性 API fixture / 仅监听 127.0.0.1</code></div><aside id="panel"></aside></main>
<script src="/react-bundle.js"></script><script>
const ReactDOMClient=ReactDOM;window.fixtureVersions={react:React.version,reactDom:ReactDOM.version};
const registered=new Map();const tabs=[];const disposers=[];
const slots={inject:(name,fn)=>fn(),register:(spec,component)=>{const key=spec.name+':'+(spec.key??spec.id);registered.set(key,component);return()=>registered.delete(key)}};
const services={slots,sidebarRightTabs:{register:entry=>{tabs.push(entry);return()=>tabs.pop()}}};
const ctx={get:name=>services[name],effect:fn=>disposers.push(fn()),inject:(names,fn)=>fn(ctx)};
window.__ModuleLoader__={load:entry=>{if(entry.id!=='dsh-step-risk')throw Error('Unexpected client id');entry.factory(name=>{if(name!=='react')throw Error('Unexpected dependency');return React}).apply(ctx)}};
</script><script src="/client.js"></script><script>
const root=ReactDOMClient.createRoot(document.getElementById('panel'));let mode='native',visible=true,sessionId='fixture-session-a';
function render(){const component=registered.get(mode==='native'?'sidebar.right.pane.tab:dsh-step-risk/overview':'settings.section:dsh-step-risk');document.getElementById('panel').style.visibility=visible?'visible':'hidden';root.render(React.createElement(component,mode==='native'?{sessionId,useTabInfo:()=>({tab:{visible}})}:{}))}
document.getElementById('native').onclick=()=>{mode='native';visible=true;render()};document.getElementById('settings').onclick=()=>{mode='settings';visible=true;render()};
document.getElementById('hide').onclick=()=>{visible=false;render()};document.getElementById('show').onclick=()=>{visible=true;render()};
document.getElementById('fixture-session').onchange=event=>{sessionId=event.target.value;render()};render();
</script></html>`
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/api/dsh-step-risk/snapshot') {
      const sessionId = url.searchParams.get('sessionId') || 'fixture-session-a'
      requests.push({ sessionId, method: request.method, at: Date.now() })
      if (serverState.delaySession === sessionId) await new Promise(resolve => setTimeout(resolve, 400))
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      if (serverState.fail) { response.writeHead(503); response.end(JSON.stringify({ error: 'fixture unavailable' })); return }
      response.end(JSON.stringify({ schemaVersion: 1, pluginVersion: '0.2.0', calibration: 'experimental_uncalibrated', sessionId,
        sessions: Object.keys(records).map(id => ({ sessionId: id, updatedAt: fixedTime, stepCount: records[id].length })),
        steps: records[sessionId] || [], updatedAt: fixedTime }))
      return
    }
    const content = url.pathname === '/' ? html : url.pathname === '/react-bundle.js' ? bundle.code : url.pathname === '/client.js' ? clientSource : null
    if (content === null) { response.writeHead(404); response.end(); return }
    response.setHeader('Content-Type', url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8')
    response.end(content)
  })
  let browser
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true, ...(chromiumExecutable ? { executablePath: resolve(chromiumExecutable) } : {}) })
    const page = await browser.newPage({ viewport: { width: 1240, height: 1000 }, locale: 'zh-CN' })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('503') && !message.text().includes('404')) errors.push(message.text()) })
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.getByRole('article').nth(2).waitFor()
    assert.match(await page.getByRole('article').first().innerText(), /1\.2%/)
    assert.equal(await page.getByRole('article').count(), 3)
    checks.push('real-react-dom-renders-three-step-rows-and-decimal-probabilities')
    await page.getByLabel('步骤排序').selectOption('risk')
    assert.match(await page.getByRole('article').first().innerText(), /13\.5%/)
    await page.getByRole('article').first().locator('summary').click()
    const expanded = await page.getByRole('article').first().innerText()
    assert.match(expanded, /45\.0%.*60\.0%.*50\.0%/s)
    assert.match(expanded, /修订 0/)
    checks.push('risk-sort-and-conditional-factor-details-and-zero-revision')
    assert.equal(await page.locator('#panel').evaluate(element => element.scrollWidth <= element.clientWidth), true)
    mkdirSync(dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: true })
    checks.push('420px-sidebar-no-horizontal-overflow-and-screenshot')
    await page.getByLabel('Fixture session').selectOption('fixture-session-b')
    await page.getByText('session_b_read', { exact: true }).waitFor()
    assert.equal(await page.getByRole('article').count(), 1)
    assert.doesNotMatch(await page.locator('#panel').innerText(), /runtime_probe/)
    checks.push('session-switch-displays-only-selected-session')
    serverState.delaySession = 'fixture-session-a'
    await page.getByLabel('Fixture session').selectOption('fixture-session-a')
    await page.getByLabel('Fixture session').selectOption('fixture-session-b')
    await page.getByText('session_b_read', { exact: true }).waitFor()
    await page.waitForTimeout(500)
    assert.doesNotMatch(await page.locator('#panel').innerText(), /runtime_probe/)
    serverState.delaySession = null
    checks.push('delayed-old-session-response-does-not-overwrite-current-session')
    await page.getByLabel('Fixture session').selectOption('fixture-session-empty')
    await page.getByText(/暂无已完成步骤/).waitFor()
    assert.equal(await page.getByRole('article').count(), 0)
    checks.push('empty-session-state')
    await page.getByLabel('Fixture session').selectOption('fixture-session-b')
    await page.getByText('session_b_read', { exact: true }).waitFor()
    serverState.fail = true
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /503.*保留上次成功读取/s)
    assert.match(await page.locator('#panel').innerText(), /session_b_read/)
    checks.push('read-error-keeps-previous-data-and-shows-visible-alert')
    serverState.fail = false
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByRole('alert').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Hide panel', exact: true }).click()
    const hiddenRequestCount = requests.length
    await page.waitForTimeout(2200)
    assert.equal(requests.length, hiddenRequestCount)
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/dsh-step-risk/snapshot')),
      page.getByRole('button', { name: 'Show panel', exact: true }).click(),
    ])
    assert.ok(requests.length > hiddenRequestCount)
    checks.push('hidden-native-tab-stops-polling-and-show-resumes')
    await page.getByRole('button', { name: 'Settings slot fixture', exact: true }).click()
    await page.getByLabel('选择会话').selectOption('fixture-session-b')
    await page.getByText('session_b_read', { exact: true }).waitFor()
    checks.push('global-settings-selects-and-renders-session')
    assert.ok(requests.every(request => request.method === 'GET'))
    assert.deepEqual(errors, [])
    checks.push('read-only-get-requests-and-no-browser-javascript-errors')
    const versions = await page.evaluate(() => window.fixtureVersions)
    const report = {
      verifiedAt: new Date().toISOString(), dshVersion: bundle.version, reactVersion: versions.react,
      reactDomVersion: versions.reactDom, browser: await browser.version(),
      mode: 'headless-chromium-real-react-dom-minimal-dsh-slot-host-deterministic-api-fixtures',
      nativeHarnessRendererMounted: false, liveProviderRequest: false, width: 1240, height: 1000, sidebarWidth: 420,
      clientSha256: createHash('sha256').update(clientSource).digest('hex'),
      status: 'passed', checks, requestCount: requests.length, browserErrors: errors,
      screenshot: relative(project, screenshotPath).replaceAll('\\', '/'),
      reactSource: 'npm registry UMD builds matching the official rc.2 source pnpm-lock.yaml pins',
      boundary: 'Uses the unmodified published client.js and real React/ReactDOM 18.3.1 matching the official rc.2 source lockfile. Slot services and GET data are test fixtures; native DSH frontend navigation and lifecycle are not exercised.',
    }
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}
