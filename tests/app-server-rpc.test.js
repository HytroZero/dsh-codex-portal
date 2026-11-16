import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CodexAppServerClient } from '../dist/codex-app-server.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MOCK_SCRIPT = join(ROOT, 'tests', 'support', 'mock-codex-cli.mjs')

async function createMockShim(dir) {
  const scriptCopy = join(dir, 'mock-codex-cli.mjs')
  await copyFile(MOCK_SCRIPT, scriptCopy)
  if (process.platform === 'win32') {
    const cmdPath = join(dir, 'codex.cmd')
    await writeFile(cmdPath, `@echo off\r\n"%dp0%\\mock-codex-cli.mjs" %*\r\n`, 'utf8')
    return cmdPath
  }
  const shPath = join(dir, 'codex')
  await writeFile(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptCopy}" "$@"\n`, 'utf8')
  await chmod(shPath, 0o755)
  return shPath
}

test('CodexAppServerClient completes handshake, paginated model/list, thread lifecycle, and approvals', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-rpc-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bin = await createMockShim(dir)

  const client = new CodexAppServerClient({ binaryPath: bin })
  t.after(() => client.close())

  const seenRequests = []
  client.setServerRequestHandler(async (req) => {
    seenRequests.push(req)
    if (req.method === 'item/commandExecution/requestApproval') {
      return { decision: 'accept' }
    }
    return {}
  })

  const account = await client.readAccount()
  assert.equal(account.authenticated, true)
  assert.match(account.accountLabel ?? '', /mock@example\.com/)

  const models = await client.listModels()
  assert.equal(models.length, 2)
  assert.equal(models[0]?.id, 'gpt-5.4')
  assert.equal(models[1]?.id, 'gpt-5.3-codex')

  const { threadId } = await client.startThread({
    cwd: dir,
    model: 'gpt-5.4',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
  })
  assert.equal(threadId, 'thr_mock_1')

  const notifications = []
  const completed = new Promise((resolve) => {
    client.on('notification', (n) => {
      notifications.push(n)
      if (n.method === 'turn/completed') resolve(n)
    })
  })

  await client.startTurn({
    threadId,
    input: 'NEED_APPROVAL',
    cwd: dir,
    model: 'gpt-5.4',
    effort: 'high',
  })

  await completed
  assert.equal(seenRequests.length, 1)
  assert.equal(seenRequests[0]?.method, 'item/commandExecution/requestApproval')
  assert.ok(notifications.some(n => n.method === 'item/agentMessage/delta' && n.params.delta === 'Approved and executed.'))

  const resumed = await client.resumeThread(threadId, { cwd: dir })
  assert.equal(resumed.threadId, threadId)
})
