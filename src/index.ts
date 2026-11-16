import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { createUserMessage, LlmError, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { CodexAppServerClient } from './codex-app-server.js'
import { probeCodexCliHealth, resolveCodexBinary } from './codex-binary.js'
import {
  createExternalCliEngineRegistry,
  type ExternalCliApprovalPolicy,
  type ExternalCliEngine,
  type ExternalCliHealth,
  type ExternalCliModelInfo,
  type ExternalCliSandboxMode,
  type ExternalCliTurnConfig,
} from './external-cli-contract.js'
import {
  assertModeModelIsolation,
  CODEX_PRESET_ID,
  CODEX_PROVIDER_ID,
  CodexIsolationRegistry,
  DEFAULT_CODEX_CONFIG,
  ensureCodexModelSelection,
  type CodexPluginStoredConfig,
} from './model-isolation.js'
import {
  createCodexPortalRemoteInfo,
  type CodexPortalSelectModelParams,
  type CodexPortalSessionConfigParams,
  type CodexPortalSessionInfo,
  type CodexPortalStatusSnapshot,
  type CodexPortalStoredSettings,
} from './remote.js'
import { CodexSessionProjector } from './session-projector.js'

export const name = 'codex-portal'
export const inject = ['agents', 'sessions', 'llm']

export interface Config {
  binaryPath?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  defaultSandboxMode?: ExternalCliSandboxMode
  defaultApprovalPolicy?: ExternalCliApprovalPolicy
  configPath?: string
}

export interface CodexPortalService {
  readonly engine: ExternalCliEngine
  registerPresetScope(targetCtx: Context): void
  remoteStatus(): Promise<CodexPortalStatusSnapshot>
  remoteCheckHealth(): Promise<CodexPortalStatusSnapshot>
  remoteWatch(signal?: AbortSignal): AsyncGenerator<CodexPortalStatusSnapshot>
  remoteSetConfig(patch: Partial<CodexPortalStoredSettings>): Promise<CodexPortalStatusSnapshot>
  remoteSessionInfo(sessionId: string): Promise<CodexPortalSessionInfo>
  remoteSelectModel(input: CodexPortalSelectModelParams): Promise<CodexPortalSessionInfo>
  remoteSetSessionConfig(input: CodexPortalSessionConfigParams): Promise<CodexPortalSessionInfo>
  typertRemote?: ReturnType<typeof bindTypertRemote>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexPortal: CodexPortalService
  }
}

function dshHome(): string {
  const configured = process.env.DSH_HOME
  return configured && isAbsolute(configured) ? configured : join(homedir(), '.dsh')
}

async function loadStoredConfig(filePath: string, defaults: Config): Promise<CodexPluginStoredConfig> {
  const base: CodexPluginStoredConfig = {
    defaultSandboxMode: defaults.defaultSandboxMode ?? DEFAULT_CODEX_CONFIG.defaultSandboxMode,
    defaultApprovalPolicy: defaults.defaultApprovalPolicy ?? DEFAULT_CODEX_CONFIG.defaultApprovalPolicy,
    ...(defaults.binaryPath ? { binaryPath: defaults.binaryPath } : {}),
    ...(defaults.defaultModel ? { defaultModel: defaults.defaultModel } : {}),
    ...(defaults.defaultReasoningEffort ? { defaultReasoningEffort: defaults.defaultReasoningEffort } : {}),
  }
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    return {
      ...base,
      ...(typeof raw.binaryPath === 'string' && raw.binaryPath.trim() ? { binaryPath: raw.binaryPath.trim() } : {}),
      ...(typeof raw.defaultModel === 'string' && raw.defaultModel.trim() ? { defaultModel: raw.defaultModel.trim() } : {}),
      ...(typeof raw.defaultReasoningEffort === 'string' && raw.defaultReasoningEffort.trim()
        ? { defaultReasoningEffort: raw.defaultReasoningEffort.trim() }
        : {}),
      ...(raw.defaultSandboxMode === 'read-only' || raw.defaultSandboxMode === 'workspace-write' || raw.defaultSandboxMode === 'danger-full-access'
        ? { defaultSandboxMode: raw.defaultSandboxMode }
        : {}),
      ...(raw.defaultApprovalPolicy === 'untrusted'
        || raw.defaultApprovalPolicy === 'on-request'
        || raw.defaultApprovalPolicy === 'auto-review'
        || raw.defaultApprovalPolicy === 'never'
        ? { defaultApprovalPolicy: raw.defaultApprovalPolicy }
        : {}),
    }
  } catch {
    return base
  }
}

async function saveStoredConfig(filePath: string, config: CodexPluginStoredConfig): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(tmp, filePath)
}

export async function apply(ctx: Context, initialConfig: Config = {}) {
  const configPath = initialConfig.configPath ?? join(dshHome(), 'codex-portal', 'config.json')
  let storedConfig = await loadStoredConfig(configPath, initialConfig)
  const isolation = new CodexIsolationRegistry()

  let appServer: CodexAppServerClient | undefined
  let cachedHealth: ExternalCliHealth | undefined
  let cachedModels: ExternalCliModelInfo[] = []
  let probeInflight: Promise<ExternalCliHealth> | undefined
  let modelsInflight: Promise<ExternalCliModelInfo[]> | undefined

  const watchers = new Set<() => void>()
  let snapshotVersion = 0
  const notifyWatchers = () => {
    snapshotVersion += 1
    for (const wake of watchers) wake()
  }

  let projector!: CodexSessionProjector

  async function getAppServer(): Promise<CodexAppServerClient> {
    const binaryPath = await resolveCodexBinary({ configuredPath: storedConfig.binaryPath })
    if (!binaryPath) {
      throw new HarnessError(
        'Codex CLI binary was not found. Install @openai/codex or configure binaryPath in Codex CLI settings.',
        'CLI_NOT_FOUND',
      )
    }
    if (!appServer) {
      appServer = new CodexAppServerClient({
        binaryPath,
        onWarn: msg => ctx.logger.warn(msg),
      })
      appServer.setServerRequestHandler(req => projector.handleServerRequest(req))
      appServer.on('exit', () => {
        projector.onServerDisconnected()
      })
    } else {
      appServer.setBinaryPath(binaryPath)
    }
    await appServer.ensureConnected()
    return appServer
  }

  projector = new CodexSessionProjector(
    ctx,
    getAppServer,
    () => storedConfig,
    sessionId => isolation.getSessionConfig(sessionId),
  )

  async function checkHealth(forceRefresh = false): Promise<ExternalCliHealth> {
    if (!forceRefresh && cachedHealth) return cachedHealth
    if (!forceRefresh && probeInflight) return probeInflight
    probeInflight = probeCodexCliHealth({
      configuredPath: storedConfig.binaryPath,
    }).then((health) => {
      cachedHealth = health
      notifyWatchers()
      return health
    }).finally(() => {
      probeInflight = undefined
    })
    return probeInflight
  }

  async function listModels(forceRefresh = false): Promise<ExternalCliModelInfo[]> {
    if (!forceRefresh && cachedModels.length > 0) return cachedModels
    if (!forceRefresh && modelsInflight) return modelsInflight
    modelsInflight = (async () => {
      const health = await checkHealth(forceRefresh)
      if (!health.available) return []
      try {
        const server = await getAppServer()
        const list = await server.listModels()
        cachedModels = list
        notifyWatchers()
        return list
      } catch (error) {
        ctx.logger.warn(`codex-portal model/list failed: ${error instanceof Error ? error.message : String(error)}`)
        return cachedModels
      }
    })().finally(() => {
      modelsInflight = undefined
    })
    return modelsInflight
  }

  let disposed = false
  ctx.effect(() => () => {
    disposed = true
  }, 'codex-portal: lifecycle flag')

  function isLiveCodexAgent(agent: Agent): boolean {
    return !disposed && ctx.agents.get(agent.id) === agent && isolation.isCodexAgent(agent)
  }

  function syncCodexAgentSelection(agent: Agent) {
    if (!isLiveCodexAgent(agent)) return
    ensureCodexModelSelection(agent, cachedModels, storedConfig, isolation.getSessionConfig(agent.id))
    if (cachedModels.length === 0) {
      void listModels().then((models) => {
        if (!isLiveCodexAgent(agent) || models.length === 0) return
        const boundary = ctx.agents.turnBoundaryOf(agent.session)
        if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) return
        if (agent.model.current()?.model === 'codex-default') {
          ensureCodexModelSelection(agent, models, storedConfig, isolation.getSessionConfig(agent.id))
        }
      }).catch((error) => {
        ctx.logger.warn(`codex-portal: failed to refresh model selection: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  const engine: ExternalCliEngine = {
    id: 'codex-portal',
    presetId: CODEX_PRESET_ID,
    label: 'Codex Portal',
    supportedSandboxes: ['read-only', 'workspace-write', 'danger-full-access'],
    supportedApprovals: ['untrusted', 'on-request', 'never'],
    checkHealth,
    listModels,
    async configureSession(sessionId: string, config: ExternalCliTurnConfig) {
      isolation.bindSession(sessionId, config)
      const agent = ctx.agents.get(brandString<SessionId>(sessionId))
      if (agent) {
        const models = cachedModels.length > 0 ? cachedModels : await listModels().catch(() => [])
        if (config.model) {
          agent.model.select({
            provider: CODEX_PROVIDER_ID,
            model: config.model,
            ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort as ReasoningEffortId } : {}),
          })
        } else {
          ensureCodexModelSelection(agent, models, storedConfig, config)
        }
      }
    },
    async runSessionTurn({ sessionId, input, config, signal, onApprovalRequest }) {
      const health = await checkHealth()
      if (!health.available) {
        throw new HarnessError(health.message ?? 'Codex CLI not found', health.errorCode ?? 'CLI_NOT_FOUND')
      }
      if (!health.authenticated) {
        throw new HarnessError(health.message ?? 'Codex CLI not authenticated', 'CLI_NOT_AUTHENTICATED')
      }
      isolation.bindSession(sessionId, config)
      const agent = ctx.agents.get(brandString<SessionId>(sessionId))
      if (!agent) {
        throw new HarnessError(`Codex session ${sessionId} is not loaded`, 'SESSION_UNAVAILABLE')
      }
      if (config) {
        await engine.configureSession(sessionId, config)
      }
      if (onApprovalRequest) {
        projector.setApprovalListener(sessionId, onApprovalRequest)
      }
      try {
        const message = createUserMessage({
          content: [{ type: 'text', text: input }],
          source: { kind: 'user' },
        })
        let replyText = ''
        let firstTurn: number | undefined
        let admitted = false
        const settled = Promise.withResolvers<string>()
        const unsub = ctx.on('session/event', (session, event) => {
          if (session !== agent.session) return
          if (event.type === 'turn/start') firstTurn ??= event.data.turn
          if (event.type === 'user/message' && event.data.id === message.id) admitted = true
          if (event.type === 'assistant/message' && admitted && event.data.turn === firstTurn) {
            const text = event.data.message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
            if (text) replyText = text
          }
          if (event.type === 'turn/end' && event.data.turn === firstTurn) {
            if (admitted && event.data.reason.kind === 'completed') settled.resolve(replyText)
            else settled.reject(new Error(event.data.reason.kind === 'error' ? event.data.reason.error.message : `Turn ended: ${event.data.reason.kind}`))
          }
        })
        const onAbort = () => {
          void projector.cancelSessionTurn(sessionId)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          agent.followup(message)
          const text = await settled.promise
          const threadId = (await projector.readSessionThreadId(sessionId)) ?? ''
          return { replyText: text, threadId }
        } finally {
          unsub()
          signal.removeEventListener('abort', onAbort)
        }
      } finally {
        if (onApprovalRequest) {
          projector.setApprovalListener(sessionId, undefined)
        }
      }
    },
    isSessionBusy(sessionId) {
      return projector.isSessionBusy(sessionId)
    },
    async cancelSessionTurn(sessionId) {
      await projector.cancelSessionTurn(sessionId)
    },
    readSessionThreadId(sessionId) {
      return projector.readSessionThreadId(sessionId)
    },
    getSessionConfig(sessionId) {
      return isolation.getSessionConfig(sessionId)
    },
    resolveApproval(requestId, decision) {
      return projector.resolvePendingApproval(requestId, decision)
    },
  }

  let registry = ctx.root.get('externalCliEngines')
  if (!registry) {
    registry = createExternalCliEngineRegistry()
    ctx.provide('externalCliEngines', registry)
  }
  ctx.effect(() => registry!.register(engine), 'codex-portal: register externalCliEngine')

  // Global mode-model isolation & stream takeover for Codex Portal turns
  ctx.effect(() => ctx.on('agent/request', async (req, next) => {
    const config = await next()
    assertModeModelIsolation({
      agent: req.agent,
      selection: {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      },
      isCodexSession: isolation.isCodexAgent(req.agent),
      models: cachedModels.length > 0 ? cachedModels : undefined,
    })
    return config
  }), 'codex-portal: global agent/request mode-model isolation')

  ctx.effect(() => ctx.on('llm/stream', async function* (options, next) {
    const sessionId = options.sessionId
    const agent = sessionId ? ctx.agents.get(sessionId) : undefined
    const isCodex = agent ? isolation.isCodexAgent(agent) : options.provider === CODEX_PROVIDER_ID

    if (isCodex && options.provider !== CODEX_PROVIDER_ID) {
      throw new LlmError(
        `Codex Portal session "${String(sessionId)}" cannot dispatch to non-Codex provider "${options.provider}".`,
        'INVALID_REQUEST',
      )
    }
    if (!isCodex && options.provider === CODEX_PROVIDER_ID) {
      throw new LlmError(
        'Codex Portal models cannot be used outside Codex Portal mode or Codex-bound DeepDuet sessions.',
        'NO_ADAPTER',
      )
    }
    if (options.provider !== CODEX_PROVIDER_ID) {
      yield* next()
      return
    }
    if (!agent) {
      throw new LlmError('Codex Portal stream requires an active DSH Agent session.', 'INVALID_REQUEST')
    }
    assertModeModelIsolation({
      agent,
      selection: {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      },
      isCodexSession: true,
      models: cachedModels.length > 0 ? cachedModels : undefined,
    })
    yield* projector.streamAgentTurn(agent, options)
  }), 'codex-portal: llm/stream takeover and isolation')

  // Initialize default Codex model selection when an Agent enters or switches preset
  ctx.effect(() => ctx.on('agent/created', async ({ agent }) => {
    syncCodexAgentSelection(agent)
  }), 'codex-portal: sync selection on agent create')

  ctx.effect(() => ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    // `agent-preset/selected` is emitted synchronously inside `Session.append()`.
    // Defer `agent.model.select()` until after the current append finishes publishing
    // to avoid reentering `Session.publicationEntry()`.
    queueMicrotask(() => {
      if (disposed) return
      const agent = ctx.agents.get(sessionId)
      if (!agent) return
      if (agentPreset === CODEX_PRESET_ID) {
        try {
          syncCodexAgentSelection(agent)
        } catch (error) {
          ctx.logger.warn(`codex-portal: failed to sync selection on preset switch: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
      if (!isolation.isCodexAgent(agent) && agent.model.current()?.provider === CODEX_PROVIDER_ID) {
        const defaults = ctx.root.get('agentDefaultModel') as {
          currentSelection?: () => { provider: string; model: string; reasoningEffort?: ReasoningEffortId } | undefined
        } | undefined
        const fallback = defaults?.currentSelection?.()
        if (fallback?.provider && fallback.model && fallback.provider !== CODEX_PROVIDER_ID) {
          try {
            agent.model.select(fallback)
          } catch (error) {
            ctx.logger.warn(`codex-portal: failed to restore default model on preset switch: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    })
  }), 'codex-portal: sync selection on preset switch')

  function registerPresetScope(targetCtx: Context) {
    targetCtx.effect(() => targetCtx.on('agent/request', async (req, next) => {
      const config = await next()
      assertModeModelIsolation({
        agent: req.agent,
        selection: {
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        },
        isCodexSession: true,
        models: cachedModels.length > 0 ? cachedModels : undefined,
      })
      return config
    }), 'codex-portal-runtime: agent/request isolation')
  }

  async function buildStatusSnapshot(forceRefresh: boolean): Promise<CodexPortalStatusSnapshot> {
    const health = await checkHealth(forceRefresh)
    const models = health.available ? await listModels(forceRefresh) : []
    return {
      health,
      models,
      config: { ...storedConfig },
    }
  }

  async function buildSessionInfo(sessionId: string): Promise<CodexPortalSessionInfo> {
    const agent = ctx.agents.get(brandString<SessionId>(sessionId))
    const sessionCfg = isolation.getSessionConfig(sessionId)
    const selection = agent?.model.current()
    const presetService = ctx.root.get('agentPresets') as {
      composedPreset?(targetCtx: unknown): string | undefined
      presetForSession?(session: unknown): string | null
    } | undefined
    const presetId = (agent
      ? (presetService?.composedPreset?.(agent.ctx) ?? presetService?.presetForSession?.(agent.session))
      : undefined)
      ?? agent?.session.header.agentPreset
      ?? undefined
    const isCodexSession = agent ? isolation.isCodexAgent(agent) : isolation.isBound(sessionId)
    const threadId = await projector.readSessionThreadId(sessionId)
    return {
      sessionId,
      isCodexSession,
      ...(presetId ? { presetId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(selection?.provider === CODEX_PROVIDER_ID ? { model: selection.model } : sessionCfg?.model ? { model: sessionCfg.model } : {}),
      ...(selection?.provider === CODEX_PROVIDER_ID && selection.reasoningEffort
        ? { reasoningEffort: selection.reasoningEffort }
        : sessionCfg?.reasoningEffort
          ? { reasoningEffort: sessionCfg.reasoningEffort }
          : {}),
      sandboxMode: sessionCfg?.sandboxMode ?? storedConfig.defaultSandboxMode,
      approvalPolicy: sessionCfg?.approvalPolicy ?? storedConfig.defaultApprovalPolicy,
      busy: projector.isSessionBusy(sessionId),
    }
  }

  const service: CodexPortalService = {
    engine,
    registerPresetScope,
    remoteStatus: () => buildStatusSnapshot(false),
    remoteCheckHealth: () => buildStatusSnapshot(true),
    async *remoteWatch(signal?: AbortSignal) {
      let seen = snapshotVersion
      yield await buildStatusSnapshot(false)
      while (!signal?.aborted) {
        if (snapshotVersion === seen) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              watchers.delete(finish)
              signal?.removeEventListener('abort', finish)
              resolve()
            }
            watchers.add(finish)
            signal?.addEventListener('abort', finish, { once: true })
            if (snapshotVersion !== seen || signal?.aborted) finish()
          })
        }
        if (signal?.aborted) break
        seen = snapshotVersion
        yield await buildStatusSnapshot(false)
      }
    },
    async remoteSetConfig(patch) {
      const next: CodexPluginStoredConfig = {
        ...storedConfig,
        ...(patch.binaryPath !== undefined ? (patch.binaryPath.trim() ? { binaryPath: patch.binaryPath.trim() } : { binaryPath: undefined }) : {}),
        ...(patch.defaultModel !== undefined ? (patch.defaultModel.trim() ? { defaultModel: patch.defaultModel.trim() } : { defaultModel: undefined }) : {}),
        ...(patch.defaultReasoningEffort !== undefined
          ? (patch.defaultReasoningEffort.trim() ? { defaultReasoningEffort: patch.defaultReasoningEffort.trim() } : { defaultReasoningEffort: undefined })
          : {}),
        ...(patch.defaultSandboxMode !== undefined ? { defaultSandboxMode: patch.defaultSandboxMode } : {}),
        ...(patch.defaultApprovalPolicy !== undefined ? { defaultApprovalPolicy: patch.defaultApprovalPolicy } : {}),
      }
      if (!next.binaryPath) delete next.binaryPath
      if (!next.defaultModel) delete next.defaultModel
      if (!next.defaultReasoningEffort) delete next.defaultReasoningEffort

      const binaryChanged = next.binaryPath !== storedConfig.binaryPath
      storedConfig = next
      await saveStoredConfig(configPath, storedConfig)
      if (binaryChanged) {
        cachedHealth = undefined
        cachedModels = []
        await appServer?.restart()
      }
      notifyWatchers()
      return buildStatusSnapshot(binaryChanged)
    },
    remoteSessionInfo: buildSessionInfo,
    async remoteSelectModel({ sessionId, model, reasoningEffort }) {
      const agent = ctx.agents.get(brandString<SessionId>(sessionId))
      if (!agent || !isolation.isCodexAgent(agent)) {
        throw new HarnessError(`Session "${sessionId}" is not running in Codex Portal mode`, 'INVALID_MODE')
      }
      const models = cachedModels.length > 0 ? cachedModels : await listModels().catch(() => [])
      if (models.length > 0 && !models.some(m => m.id === model)) {
        throw new HarnessError(`Model "${model}" is not advertised by Codex CLI`, 'INVALID_MODEL')
      }
      const matched = models.find(m => m.id === model)
      const resolvedEffort = reasoningEffort ?? matched?.defaultReasoningEffort
      agent.model.select({
        provider: CODEX_PROVIDER_ID,
        model,
        ...(resolvedEffort ? { reasoningEffort: resolvedEffort as ReasoningEffortId } : {}),
      })
      isolation.setSessionConfig(sessionId, {
        model,
        ...(resolvedEffort ? { reasoningEffort: resolvedEffort } : {}),
      })
      return buildSessionInfo(sessionId)
    },
    async remoteSetSessionConfig({ sessionId, sandboxMode, approvalPolicy }) {
      isolation.setSessionConfig(sessionId, {
        ...(sandboxMode ? { sandboxMode } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
      })
      return buildSessionInfo(sessionId)
    },
  }

  service.typertRemote = bindTypertRemote(service, 'codexPortal')
  ctx.provide('codexPortal', service)

  ctx.inject(['typert'], (typertCtx) => {
    const info = createCodexPortalRemoteInfo(z)
    typertCtx.effect(() => typertCtx.typert.register({
      package: 'dsh-codex-portal',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: info.descriptors,
    }), 'codex-portal: typert host registration')
  })

  ctx.effect(() => async () => {
    await appServer?.close()
  }, 'codex-portal: close app-server')
}
