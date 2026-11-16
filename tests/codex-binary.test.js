import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildCodexSpawnSpec, probeCodexCliHealth, resolveCodexBinary } from '../dist/codex-binary.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MOCK_SCRIPT = join(ROOT, 'tests', 'support', 'mock-codex-cli.mjs')

async function createMockShim(dir) {
  const scriptCopy = join(dir, 'mock-codex-cli.mjs')
  await copyFile(MOCK_SCRIPT, scriptCopy)
  if (process.platform === 'win32') {
    const cmdPath = join(dir, 'codex.cmd')
    await writeFile(cmdPath, `@echo off\r\n"%~dp0\\node.exe" "%dp0%\\mock-codex-cli.mjs" %*\r\n`, 'utf8')
    return cmdPath
  }
  const shPath = join(dir, 'codex')
  await writeFile(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptCopy}" "$@"\n`, 'utf8')
  await chmod(shPath, 0o755)
  return shPath
}

test('resolveCodexBinary finds configured path and PATH shims without shell injection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-bin-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const bin = await createMockShim(dir)
  assert.equal(await resolveCodexBinary({ configuredPath: bin }), bin)
  assert.equal(await resolveCodexBinary({ configuredPath: join(dir, 'missing-codex') }), undefined)

  const foundOnPath = await resolveCodexBinary({
    env: { ...process.env, PATH: dir },
  })
  assert.equal(foundOnPath, bin)

  if (process.platform === 'win32') {
    const spec = await buildCodexSpawnSpec(bin, ['--version'], 'win32')
    assert.equal(spec.command, process.execPath)
    assert.deepEqual(spec.args, [join(dir, 'mock-codex-cli.mjs'), '--version'])
  }
})

test('probeCodexCliHealth reports CLI_NOT_FOUND, CLI_NOT_AUTHENTICATED, and authenticated status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-health-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const missing = await probeCodexCliHealth({ configuredPath: join(dir, 'nope') })
  assert.equal(missing.available, false)
  assert.equal(missing.errorCode, 'CLI_NOT_FOUND')

  const bin = await createMockShim(dir)

  const unauth = await probeCodexCliHealth({
    configuredPath: bin,
    env: { ...process.env, MOCK_CODEX_AUTH: 'unauthenticated' },
  })
  assert.equal(unauth.available, true)
  assert.equal(unauth.authenticated, false)
  assert.equal(unauth.errorCode, 'CLI_NOT_AUTHENTICATED')
  assert.match(unauth.version ?? '', /0\.42\.0-mock/)

  const ok = await probeCodexCliHealth({
    configuredPath: bin,
    env: { ...process.env, MOCK_CODEX_AUTH: 'authenticated' },
  })
  assert.equal(ok.available, true)
  assert.equal(ok.authenticated, true)
  assert.equal(ok.binaryPath, bin)
  assert.match(ok.accountLabel ?? '', /mock@example\.com/)
})
