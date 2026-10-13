#!/usr/bin/env node
/** Launch the compatibility smoke under the installed Desktop's Electron Node. */
const { spawnSync } = require('node:child_process')
const { existsSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, resolve, dirname } = require('node:path')

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return process.argv[index + 1]
}

try {
  const executable = resolve(argument('--electron') ?? process.env.DSH_DESKTOP_EXECUTABLE
    ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'))
  const runtime = resolve(argument('--runtime-root')
    ?? join(dirname(executable), 'resources', 'app.asar', 'dsh'))
  const reportPath = argument('--report')
  if (!existsSync(executable)) throw new Error(`DeepSeek Harness executable not found: ${executable}`)
  const result = spawnSync(executable, [
    '--expose-internals', join(__dirname, 'dsh-runtime-smoke.mjs'), runtime,
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' },
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Runtime smoke exited with ${result.status ?? result.signal}`)
  const reportLine = result.stdout.split(/\r?\n/).find(line => line.startsWith('DSH_STEP_RISK_SMOKE='))
  if (!reportLine) throw new Error('Runtime smoke exited without its verification report')
  const report = JSON.parse(reportLine.slice('DSH_STEP_RISK_SMOKE='.length))
  if (reportPath) {
    const target = resolve(reportPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(report, null, 2) + '\n', 'utf8')
    console.log(`Verification report: ${target}`)
  }
} catch (error) {
  console.error(error.stack ?? String(error))
  process.exitCode = 1
}
