import assert from 'node:assert/strict'
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Approval from '@deepseek-ai/dsh-user-approval'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import * as codexPlugin from '../dist/index.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MOCK_SCRIPT = join(ROOT, 'tests', 'support', 'mock-codex-cli.mjs')

const textOf = message => message.content.map(block => block.type === 'text' ? block.text : '').join('')
const userMsg = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

class MockNativeLlm extends LlmAdapter {
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'native reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'native reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

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

async function waitTurn(ctx, agent, text) {
  const done = new Promise((resolve, reject) => {
    let firstTurn
    let reply = ''
    const off = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'turn/start') firstTurn ??= event.data.turn
      if (event.type === 'assistant/message' && event.data.turn === firstTurn) {
        reply = textOf(event.data.message)
      }
      if (event.type === 'turn/end' && event.data.turn === firstTurn) {
        off()
        if (event.data.reason.kind === 'completed') resolve(reply)
        else reject(new Error(`Turn failed: ${JSON.stringify(event.data.reason)}`))
      }
    })
  })
  agent.followup(userMsg(text))
  return done
}

test('bundle manifests, presets, and client.js UMD bundle conform to DSH rules', async () => {
  await access(join(ROOT, 'dist/index.js'))
  await access(join(ROOT, 'dist/preset-runtime.js'))
  await access(join(ROOT, 'dist/client.js'))

  const cordisPatch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(cordisPatch, /name:\s*dsh-codex-portal/)

  const presetPatch = await readFile(join(ROOT, 'presets/codex-portal.patch.yml'), 'utf8')
  assert.match(presetPatch, /id:\s*codex-portal/)
  assert.match(presetPatch, /dsh-codex-portal\/runtime/)
  assert.doesNotMatch(presetPatch, /dsh-tool-bash|dsh-tool-fs|dsh-tool-pwsh/)

  const clientCode = await readFile(join(ROOT, 'dist/client.js'), 'utf8')
  let loadedModule
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          loadedModule = entry
        },
      },
    },
    document: undefined,
  }
  vm.runInNewContext(clientCode, sandbox)
  assert.equal(loadedModule.id, 'dsh-codex-portal')
  const exports = loadedModule.factory((id) => {
    if (id === 'react') return { useEffect() {}, useRef() { return { current: null } }, useState(v) { return [v, () => {}] }, useSyncExternalStore() { return {} } }
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    if (id === 'react-dom') return { createPortal: n => n }
    if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: v => ({ getSnapshot: () => v, subscribe: () => () => {}, update() {} }), shallowEqual: (a, b) => a === b }
    return {}
  })
  assert.equal(typeof exports.apply, 'function')
  assert.match(clientCode, /conversation\.input\.left/)
  assert.match(clientCode, /data-codex-permission-seat/)
  assert.match(clientCode, /auto-review/)
})

test('codex-portal executes turns, projects tools/approvals/questions, enforces mode-model isolation, and supports cold resume', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-e2e-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  const bin = await createMockShim(root)
  await ctx.plugin(Loader, { name: 'loader', root })
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Approval)
  await ctx.plugin(UserQuestions)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new MockNativeLlm())

  await ctx.plugin(AgentPresetRegistry, { default: 'standard' })
  await ctx.plugin(codexPlugin, {
    binaryPath: bin,
    configPath: join(root, 'codex-config.json'),
  })

  const runtimeUrl = new URL('../dist/preset-runtime.js', import.meta.url).href
  await ctx.agentPresets.register({
    id: 'standard',
    name: 'Standard',
    plugins: [],
  })
  await ctx.agentPresets.register({
    id: 'codex-portal',
    name: 'Codex Portal',
    plugins: [{ name: runtimeUrl }],
  })

  // Verify externalCliEngines registration & Typert endpoints
  const engine = ctx.externalCliEngines?.get('codex-portal')
  assert.ok(engine)
  const models = await engine.listModels()
  assert.equal(models.length, 2)

  // Create a native standard session and verify it CANNOT route to codex-portal
  const stdHandle = await ctx.agents.create({
    sessionId: 'std-1',
    meta: { cwd: root, agentPreset: 'standard' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'standard')
    },
  })
  assert.equal(await waitTurn(ctx, stdHandle.agent, 'hello native'), 'native reply')

  // Attempting to select codex-portal on standard session must fail during turn
  stdHandle.agent.model.select({ provider: 'codex-portal', model: 'gpt-5.4' })
  await assert.rejects(() => waitTurn(ctx, stdHandle.agent, 'bypass attempt'))

  // Create a codex-portal mode session; auto-selects codex-portal default model
  const codexHandle = await ctx.agents.create({
    sessionId: 'codex-1',
    meta: { cwd: root, agentPreset: 'codex-portal' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'codex-portal')
    },
  })
  assert.equal(codexHandle.agent.model.current()?.provider, 'codex-portal')

  // Verify tool projection + response
  const reply1 = await waitTurn(ctx, codexHandle.agent, 'RUN_COMMAND check')
  assert.match(reply1, /Codex\(gpt-5\.4\): RUN_COMMAND check/)
  const events1 = codexHandle.agent.session.snapshotEvents()
  assert.ok(events1.some(e => e.type === 'plugin:codex-portal/tool' && e.data?.phase === 'start' && e.data?.name === 'codex_command'))
  assert.ok(events1.some(e => e.type === 'plugin:codex-portal/tool' && e.data?.phase === 'result' && e.data?.name === 'codex_command'))

  // Verify thread id persisted & cold resume works
  const threadId = await engine.readSessionThreadId('codex-1')
  assert.equal(threadId, 'thr_mock_1')

  // Verify approval bridge via ctx.approval waterfall
  ctx.on('approval/request', async () => 'allowed-once')
  const reply2 = await waitTurn(ctx, codexHandle.agent, 'NEED_APPROVAL')
  assert.equal(reply2, 'Approved and executed.')

  // Verify userQuestions bridge via ctx.userQuestions waterfall
  ctx.on('user-questions/request', async (req) => ({
    answers: req.questions.map(q => ({ id: q.id, selectedOptions: ['staging'] })),
  }))
  const replyInput = await waitTurn(ctx, codexHandle.agent, 'NEED_INPUT')
  assert.equal(replyInput, 'Selected: staging')

  // Verify Typert model selection and session sandbox/approval config (including auto-review)
  const info = await ctx.codexPortal.remoteSelectModel({
    sessionId: 'codex-1',
    model: 'gpt-5.3-codex',
    reasoningEffort: 'high',
  })
  assert.equal(info.model, 'gpt-5.3-codex')
  assert.equal(info.reasoningEffort, 'high')

  const updatedSessionCfg = await ctx.codexPortal.remoteSetSessionConfig({
    sessionId: 'codex-1',
    sandboxMode: 'read-only',
    approvalPolicy: 'auto-review',
  })
  assert.equal(updatedSessionCfg.sandboxMode, 'read-only')
  assert.equal(updatedSessionCfg.approvalPolicy, 'auto-review')

  const updatedGlobalCfg = await ctx.codexPortal.remoteSetConfig({
    defaultApprovalPolicy: 'auto-review',
  })
  assert.equal(updatedGlobalCfg.config.defaultApprovalPolicy, 'auto-review')

  // Dispose and cold resume codex-1
  await codexHandle.dispose()
  const resumed = await ctx.agents.resume({
    resumeSessionId: 'codex-1',
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'codex-portal')
    },
  })
  const reply3 = await waitTurn(ctx, resumed.agent, 'after resume')
  assert.match(reply3, /Codex\(gpt-5\.3-codex\): after resume/)
  assert.ok(harness)
})

test('switching blank sessions into and out of codex-portal preset avoids session append reentrancy and restores default model', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-switch-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  const bin = await createMockShim(root)
  await ctx.plugin(Loader, { name: 'loader', root })
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Approval)
  await ctx.plugin(UserQuestions)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new MockNativeLlm())

  // Minimal agentDefaultModel provider matching host behavior when switching back to standard.
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  })

  await ctx.plugin(AgentPresetRegistry, { default: 'standard' })
  await ctx.plugin(codexPlugin, {
    binaryPath: bin,
    configPath: join(root, 'codex-config.json'),
  })

  const runtimeUrl = new URL('../dist/preset-runtime.js', import.meta.url).href
  await ctx.agentPresets.register({ id: 'standard', name: 'Standard', plugins: [] })
  await ctx.agentPresets.register({ id: 'codex-portal', name: 'Codex Portal', plugins: [{ name: runtimeUrl }] })

  // 1. Create a blank standard session BEFORE models are cached, then switch to codex-portal.
  const blankStd = await ctx.agents.create({
    sessionId: 'switch-to-codex',
    meta: { cwd: root, agentPreset: 'standard' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'standard')
    },
  })

  await ctx.agentPresets.select(blankStd.agent, 'codex-portal')
  assert.equal(blankStd.agent.model.current()?.provider, 'codex-portal')
  const switchedInfo = await ctx.codexPortal.remoteSessionInfo('switch-to-codex')
  assert.equal(switchedInfo.isCodexSession, true)
  assert.equal(switchedInfo.presetId, 'codex-portal')

  // Background listModels() should upgrade placeholder 'codex-default' to 'gpt-5.4'.
  for (let i = 0; i < 40; i += 1) {
    if (blankStd.agent.model.current()?.model === 'gpt-5.4') break
    await new Promise(r => setTimeout(r, 50))
  }
  assert.equal(blankStd.agent.model.current()?.model, 'gpt-5.4')

  const codexReply = await waitTurn(ctx, blankStd.agent, 'after preset switch')
  assert.match(codexReply, /Codex\(gpt-5\.4\): after preset switch/)

  // 2. Create a blank session starting in codex-portal, switch back to standard, and verify isolation & fallback.
  const blankCodex = await ctx.agents.create({
    sessionId: 'switch-to-std',
    meta: { cwd: root, agentPreset: 'codex-portal' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'codex-portal')
    },
  })
  assert.equal(blankCodex.agent.model.current()?.provider, 'codex-portal')

  await ctx.agentPresets.select(blankCodex.agent, 'standard')
  assert.equal(blankCodex.agent.model.current()?.provider, 'mock')
  assert.equal(blankCodex.agent.model.current()?.model, 'mock')
  const revertedInfo = await ctx.codexPortal.remoteSessionInfo('switch-to-std')
  assert.equal(revertedInfo.isCodexSession, false)
  assert.equal(revertedInfo.presetId, 'standard')

  const nativeReply = await waitTurn(ctx, blankCodex.agent, 'back to native')
  assert.equal(nativeReply, 'native reply')

  // 3. Switch another blank standard session to codex-portal when cachedModels IS populated.
  const blankStd2 = await ctx.agents.create({
    sessionId: 'switch-cached',
    meta: { cwd: root, agentPreset: 'standard' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'standard')
    },
  })
  await ctx.agentPresets.select(blankStd2.agent, 'codex-portal')
  assert.equal(blankStd2.agent.model.current()?.provider, 'codex-portal')
  assert.equal(blankStd2.agent.model.current()?.model, 'gpt-5.4')
})
