import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, type PluginRecordMap, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-working-directory'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { CodexAppServerClient, JsonRpcNotification, JsonRpcServerRequest } from './codex-app-server.js'
import type {
  ExternalCliApprovalPolicy,
  ExternalCliApprovalRequest,
  ExternalCliSandboxMode,
  ExternalCliTurnConfig,
} from './external-cli-contract.js'
import type { CodexPluginStoredConfig } from './model-isolation.js'

export const CODEX_THREAD_RECORD_TYPE = 'plugin:codex-portal/thread' as const
export const CODEX_TOOL_RECORD_TYPE = 'plugin:codex-portal/tool' as const

export interface CodexThreadRecord {
  threadId: string
  cwd: string
  model?: string
  reasoningEffort?: string
  sandboxMode?: ExternalCliSandboxMode
  approvalPolicy?: ExternalCliApprovalPolicy
}

export interface CodexToolRecord {
  phase: 'start' | 'result'
  turn: number
  step: number
  callId: string
  name: string
  arguments?: string
  text?: string
  isError?: boolean
  meta?: Record<string, unknown>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:codex-portal/thread': CodexThreadRecord
    'plugin:codex-portal/tool': CodexToolRecord
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

let hostAppendPluginRecord: typeof appendPluginRecord | undefined
function safeAppendPluginRecord<K extends keyof PluginRecordMap>(
  session: Session,
  type: K,
  data: PluginRecordMap[K],
) {
  try {
    return appendPluginRecord(session, type, data)
  } catch (error) {
    if (error instanceof TypeError && /instance of class Session/i.test(error.message)) {
      if (!hostAppendPluginRecord) {
        const req = createRequire(join(process.cwd(), 'package.json'))
        const hostDshSession = req('@deepseek-ai/dsh-session') as { appendPluginRecord: typeof appendPluginRecord }
        hostAppendPluginRecord = hostDshSession.appendPluginRecord
      }
      return hostAppendPluginRecord(session, type, data)
    }
    throw error
  }
}

function extractPromptInput(options: GenerateOptions): string {
  for (let i = options.messages.length - 1; i >= 0; i -= 1) {
    const msg = options.messages[i]
    if (!msg || msg.role !== 'user') continue
    if ('source' in msg && (msg.source as { kind?: string } | undefined)?.kind === 'runtime-context') continue
    const text = msg.content
      .flatMap(block => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

function currentTurnAndStep(ctx: Context, session: Session): { turn: number; step: number } {
  const boundary = ctx.agents.turnBoundaryOf(session)
  const turn = Math.max(1, boundary.lastTurn)
  let step = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'step/start' && event.data.turn === turn) {
      step = Math.max(step, event.data.step)
    }
  }
  return { turn, step: Math.max(1, step) }
}

function readThreadRecordFromSession(session: Session): CodexThreadRecord | undefined {
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const rec = pluginRecordOf(events[i]!)
    if (rec?.type !== CODEX_THREAD_RECORD_TYPE) continue
    const data = asObject(rec.data)
    if (typeof data.threadId === 'string' && data.threadId.length > 0) {
      return {
        threadId: data.threadId,
        cwd: typeof data.cwd === 'string' ? data.cwd : '',
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
        ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}),
        ...(typeof data.sandboxMode === 'string' ? { sandboxMode: data.sandboxMode as ExternalCliSandboxMode } : {}),
        ...(typeof data.approvalPolicy === 'string' ? { approvalPolicy: data.approvalPolicy as ExternalCliApprovalPolicy } : {}),
      }
    }
  }
  return undefined
}

function mapToolPresentation(item: Record<string, unknown>): {
  toolName: string
  args: Record<string, unknown>
} {
  const type = asString(item.type) ?? 'unknown'
  switch (type) {
    case 'commandExecution':
      return {
        toolName: 'codex_command',
        args: {
          command: asString(item.command) ?? asString(item.cmd) ?? '',
          ...(asString(item.cwd) ? { cwd: item.cwd } : {}),
        },
      }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      return {
        toolName: 'codex_file_change',
        args: {
          paths: changes.map(c => asString(asObject(c).path)).filter(Boolean),
          changeCount: changes.length,
        },
      }
    }
    case 'mcpToolCall':
      return {
        toolName: 'codex_mcp_tool',
        args: {
          server: asString(item.server) ?? '',
          tool: asString(item.tool) ?? '',
          ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
        },
      }
    case 'webSearch':
      return {
        toolName: 'codex_web_search',
        args: {
          query: asString(item.query) ?? '',
        },
      }
    default:
      return {
        toolName: `codex_${type}`,
        args: item,
      }
  }
}

function formatToolResult(item: Record<string, unknown>): {
  text: string
  isError: boolean
  meta: Record<string, unknown>
} {
  const type = asString(item.type) ?? 'unknown'
  const status = asString(item.status) ?? 'completed'
  const isError = status === 'failed' || status === 'declined'

  if (type === 'commandExecution') {
    const command = asString(item.command) ?? ''
    const output = asString(item.aggregatedOutput) ?? asString(item.stdout) ?? ''
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined
    const failed = isError || (exitCode !== undefined && exitCode !== 0)
    return {
      text: output || (exitCode !== undefined ? `Command exited with code ${exitCode}` : `Command ${status}`),
      isError: failed,
      meta: {
        kind: 'command',
        command,
        status,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(output ? { output: output.slice(0, 16_000) } : {}),
      },
    }
  }

  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes.map(c => {
      const obj = asObject(c)
      return {
        path: asString(obj.path) ?? '',
        kind: asString(obj.kind) ?? 'update',
        ...(asString(obj.diff) ? { diff: asString(obj.diff)!.slice(0, 16_000) } : {}),
      }
    }) : []
    const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n') || `File changes ${status}`
    return {
      text: summary,
      isError,
      meta: {
        kind: 'file-change',
        status,
        changes,
      },
    }
  }

  if (type === 'mcpToolCall') {
    const server = asString(item.server) ?? ''
    const tool = asString(item.tool) ?? ''
    const errorObj = item.error ? asObject(item.error) : undefined
    const resultText = errorObj?.message
      ? String(errorObj.message)
      : item.result !== undefined
        ? JSON.stringify(item.result)
        : `MCP ${server}.${tool} ${status}`
    return {
      text: resultText,
      isError: isError || Boolean(errorObj),
      meta: {
        kind: 'mcp',
        server,
        tool,
        status,
        output: resultText.slice(0, 16_000),
      },
    }
  }

  if (type === 'webSearch') {
    const query = asString(item.query) ?? ''
    return {
      text: query ? `Web search: ${query}` : `Web search ${status}`,
      isError,
      meta: { kind: 'web-search', query, status },
    }
  }

  return {
    text: JSON.stringify(item),
    isError,
    meta: { kind: type, status },
  }
}

export class CodexSessionProjector {
  private readonly threadIds = new Map<string, string>()
  private readonly loadedThreads = new Set<string>()
  private readonly threadToSession = new Map<string, string>()
  private readonly activeTurns = new Map<string, { threadId: string; turnId?: string; cancel: () => void }>()
  private readonly approvalListeners = new Map<string, (req: ExternalCliApprovalRequest) => void>()
  private readonly pendingApprovals = new Map<string, (decision: { approved: boolean; payload?: unknown }) => void>()

  constructor(
    private readonly ctx: Context,
    private readonly getServer: () => Promise<CodexAppServerClient>,
    private readonly getGlobalConfig: () => CodexPluginStoredConfig,
    private readonly getSessionConfig: (sessionId: string) => ExternalCliTurnConfig | undefined,
  ) {}

  onServerDisconnected() {
    this.loadedThreads.clear()
  }

  isSessionBusy(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  async cancelSessionTurn(sessionId: string): Promise<void> {
    const active = this.activeTurns.get(sessionId)
    if (!active) return
    active.cancel()
    if (active.turnId) {
      const server = await this.getServer().catch(() => undefined)
      await server?.interruptTurn(active.threadId, active.turnId)
    }
  }

  setApprovalListener(sessionId: string, listener?: (req: ExternalCliApprovalRequest) => void) {
    if (listener) this.approvalListeners.set(sessionId, listener)
    else this.approvalListeners.delete(sessionId)
  }

  resolvePendingApproval(requestId: string, decision: { approved: boolean; payload?: unknown }): boolean {
    const resolve = this.pendingApprovals.get(requestId)
    if (!resolve) return false
    this.pendingApprovals.delete(requestId)
    resolve(decision)
    return true
  }

  async readSessionThreadId(sessionId: string): Promise<string | undefined> {
    const cached = this.threadIds.get(sessionId)
    if (cached) return cached
    const live = this.ctx.agents.get(sessionId as Agent['id'])
    if (live) {
      const rec = readThreadRecordFromSession(live.session)
      if (rec) {
        this.threadIds.set(sessionId, rec.threadId)
        this.threadToSession.set(rec.threadId, sessionId)
        return rec.threadId
      }
    }
    const persistence = this.ctx.root.get('sessionPersistence')
    if (!persistence) return undefined
    try {
      if (!(await persistence.stat(sessionId as Agent['id']))) return undefined
      await using stored = await persistence.open(sessionId as Agent['id'], 'read')
      const { events } = await stored.read()
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const rec = pluginRecordOf(events[i]!)
        if (rec?.type === CODEX_THREAD_RECORD_TYPE) {
          const threadId = asString(asObject(rec.data).threadId)
          if (threadId) {
            this.threadIds.set(sessionId, threadId)
            this.threadToSession.set(threadId, sessionId)
            return threadId
          }
        }
      }
    } catch {
      return undefined
    }
    return undefined
  }

  async handleServerRequest(req: JsonRpcServerRequest): Promise<unknown> {
    const params = req.params
    const threadId = asString(params.threadId)
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined
    const agent = sessionId ? this.ctx.agents.get(sessionId as Agent['id']) : undefined

    const requestId = `codex-req-${randomUUID()}`
    const controller = new AbortController()

    const dualChannelPromise = new Promise<{ approved: boolean; payload?: unknown }>((resolve) => {
      let settled = false
      const settle = (decision: { approved: boolean; payload?: unknown }) => {
        if (settled) return
        settled = true
        this.pendingApprovals.delete(requestId)
        controller.abort()
        resolve(decision)
      }

      this.pendingApprovals.set(requestId, settle)

      const listener = sessionId ? this.approvalListeners.get(sessionId) : undefined
      if (listener) {
        listener(this.toExternalApprovalRequest(requestId, req, settle))
      }

      const userQuestions = this.ctx.root.get('userQuestions')
      const approval = this.ctx.root.get('approval')

      if (agent && req.method === 'item/tool/requestUserInput' && userQuestions) {
        const rawQuestions = Array.isArray(params.questions) ? params.questions : []
        const questions = rawQuestions.map((raw, idx) => {
          const q = asObject(raw)
          const opts = Array.isArray(q.options) ? q.options : []
          return {
            id: asString(q.id) ?? `q-${idx}`,
            header: asString(q.header) ?? 'Codex',
            question: asString(q.question) ?? 'Input required',
            multiSelect: false,
            options: opts.map(o => {
              const obj = asObject(o)
              return {
                label: asString(obj.label) ?? '',
                description: asString(obj.description) ?? '',
              }
            }),
          }
        })
        void userQuestions.ask({
          agent,
          questions,
          signal: controller.signal,
        }).then(
          (answer) => settle({ approved: true, payload: answer }),
          (err: unknown) => {
            const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined
            if (code === 'NO_PROVIDER' && listener) return
            if (!controller.signal.aborted) settle({ approved: false })
          },
        )
      } else if (agent && approval) {
        const toolName = req.method === 'item/fileChange/requestApproval' ? 'codex_file_change' : 'codex_command'
        const reason = req.method === 'item/fileChange/requestApproval'
          ? (asString(params.reason) ?? 'Codex CLI requests permission to apply file changes')
          : ([asString(params.command), asString(params.reason)].filter(Boolean).join(' — ') || 'Codex CLI requests command approval')
        const callId = asString(params.itemId) as ToolCallId | undefined
        void approval.request({
          agent,
          toolName,
          ...(callId ? { callId } : {}),
          reason,
          signal: controller.signal,
        }).then(
          (outcome) => {
            if (outcome === 'unavailable' && listener) return
            if (!controller.signal.aborted) settle({ approved: outcome === 'allowed-once' })
          },
          () => {
            if (!controller.signal.aborted && !listener) settle({ approved: false })
          },
        )
      } else if (!listener) {
        // Headless fallback with no UI answerer or DeepDuet listener: fail closed.
        settle({ approved: false })
      }
    })

    const decision = await dualChannelPromise
    if (req.method === 'item/tool/requestUserInput') {
      const rawQuestions = Array.isArray(params.questions) ? params.questions : []
      const payloadObj = asObject(decision.payload)
      const payloadAnswers = asObject(payloadObj.answers)
      const answers: Record<string, { answers: string[] }> = {}

      // Support both DSH AskUserQuestionAnswer ({ answers: [{ id, selectedOptions, freeText }] }) and raw map
      if (Array.isArray(payloadObj.answers)) {
        for (const itemRaw of payloadObj.answers as unknown[]) {
          const item = asObject(itemRaw)
          const qId = asString(item.id)
          if (!qId) continue
          const chosen: string[] = []
          if (Array.isArray(item.selectedOptions)) {
            for (const opt of item.selectedOptions) {
              if (typeof opt === 'string') chosen.push(opt)
            }
          }
          if (typeof item.freeText === 'string' && item.freeText.trim()) {
            chosen.push(item.freeText.trim())
          }
          answers[qId] = { answers: chosen }
        }
      } else {
        for (const raw of rawQuestions) {
          const q = asObject(raw)
          const qId = asString(q.id)
          if (!qId) continue
          const val = payloadAnswers[qId]
          if (Array.isArray(val)) {
            answers[qId] = { answers: val.map(String) }
          } else if (typeof val === 'string') {
            answers[qId] = { answers: [val] }
          } else if (typeof decision.payload === 'string') {
            answers[qId] = { answers: [decision.payload] }
          } else {
            answers[qId] = { answers: [] }
          }
        }
      }
      return { answers }
    }

    return { decision: decision.approved ? 'accept' : 'decline' }
  }

  private toExternalApprovalRequest(
    requestId: string,
    req: JsonRpcServerRequest,
    resolve: (decision: { approved: boolean; payload?: unknown }) => void,
  ): ExternalCliApprovalRequest {
    const p = req.params
    if (req.method === 'item/fileChange/requestApproval') {
      return {
        requestId,
        kind: 'file-change',
        title: 'Codex CLI File Change Approval',
        detail: asString(p.reason) ?? asString(p.grantRoot) ?? 'Allow Codex CLI to modify workspace files?',
        resolve,
      }
    }
    if (req.method === 'item/tool/requestUserInput') {
      const qs = Array.isArray(p.questions) ? p.questions.map(q => asObject(q)) : []
      const first = qs[0] ?? {}
      const opts = Array.isArray(first.options) ? first.options.map((o, i) => {
        const obj = asObject(o)
        return {
          id: String(i),
          label: asString(obj.label) ?? `Option ${i + 1}`,
          ...(asString(obj.description) ? { description: asString(obj.description) } : {}),
        }
      }) : undefined
      return {
        requestId,
        kind: 'user-input',
        title: asString(first.header) ?? 'Codex CLI Question',
        detail: asString(first.question) ?? 'Codex CLI requires user input',
        ...(opts && opts.length > 0 ? { options: opts } : {}),
        resolve,
      }
    }
    return {
      requestId,
      kind: 'command',
      title: 'Codex CLI Command Approval',
      detail: [asString(p.command), asString(p.reason)].filter(Boolean).join('\n') || 'Allow Codex CLI to run command?',
      resolve,
    }
  }

  async *streamAgentTurn(agent: Agent, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const promptText = extractPromptInput(options)
    if (!promptText) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const session = agent.session
    const sessionId = session.id
    const cwd = this.ctx.root.get('workingDirectory')?.get(session) ?? session.header.cwd ?? process.cwd()
    const globalCfg = this.getGlobalConfig()
    const sessionCfg = this.getSessionConfig(sessionId)

    const rawModel = options.model === 'codex-default' ? undefined : options.model
    const model = rawModel || sessionCfg?.model || globalCfg.defaultModel
    const effort = (options.reasoningEffort as string | undefined) || sessionCfg?.reasoningEffort || globalCfg.defaultReasoningEffort
    const sandboxMode = sessionCfg?.sandboxMode ?? globalCfg.defaultSandboxMode
    const approvalPolicy = sessionCfg?.approvalPolicy ?? globalCfg.defaultApprovalPolicy

    let server: CodexAppServerClient
    try {
      server = await this.getServer()
    } catch (error) {
      throw new LlmError(error instanceof Error ? error.message : String(error), 'UNKNOWN', { cause: error })
    }

    let threadId = await this.readSessionThreadId(sessionId)
    if (threadId && !this.loadedThreads.has(threadId)) {
      const resumed = await server.resumeThread(threadId, {
        cwd,
        ...(model ? { model } : {}),
        sandboxMode,
        approvalPolicy,
        ...(sessionCfg?.developerInstructions ? { developerInstructions: sessionCfg.developerInstructions } : {}),
        ...(sessionCfg?.mcpServers ? { mcpServers: sessionCfg.mcpServers } : {}),
      }, options.signal)
      threadId = resumed.threadId
      this.loadedThreads.add(threadId)
      this.threadIds.set(sessionId, threadId)
      this.threadToSession.set(threadId, sessionId)
    } else if (!threadId) {
      const started = await server.startThread({
        cwd,
        ...(model ? { model } : {}),
        sandboxMode,
        approvalPolicy,
        ...(sessionCfg?.developerInstructions ? { developerInstructions: sessionCfg.developerInstructions } : {}),
        ...(sessionCfg?.mcpServers ? { mcpServers: sessionCfg.mcpServers } : {}),
      }, options.signal)
      threadId = started.threadId
      this.loadedThreads.add(threadId)
      this.threadIds.set(sessionId, threadId)
      this.threadToSession.set(threadId, sessionId)
      safeAppendPluginRecord(session, CODEX_THREAD_RECORD_TYPE, {
        threadId,
        cwd,
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        sandboxMode,
        approvalPolicy,
      })
    }

    const { turn, step } = currentTurnAndStep(this.ctx, session)
    const queue: StreamChunk[] = []
    let wakeQueue: (() => void) | undefined
    let done = false
    let streamError: Error | undefined

    const pushChunk = (chunk: StreamChunk) => {
      queue.push(chunk)
      wakeQueue?.()
      wakeQueue = undefined
    }

    let nextBlockIndex = 0
    let activeTextBlock: { index: number; text: string } | undefined
    let activeReasoningBlock: { index: number; text: string } | undefined
    const openToolCalls = new Map<string, { callId: ToolCallId; name: string }>()
    let activeTurnId: string | undefined

    const closeReasoning = () => {
      if (!activeReasoningBlock) return
      pushChunk({
        type: 'block-end',
        index: activeReasoningBlock.index,
        block: { type: 'reasoning', text: activeReasoningBlock.text },
      })
      activeReasoningBlock = undefined
    }

    const closeText = () => {
      if (!activeTextBlock) return
      pushChunk({
        type: 'block-end',
        index: activeTextBlock.index,
        block: { type: 'text', text: activeTextBlock.text },
      })
      activeTextBlock = undefined
    }

    const appendReasoningDelta = (delta: string) => {
      if (!delta) return
      closeText()
      if (!activeReasoningBlock) {
        const index = nextBlockIndex++
        activeReasoningBlock = { index, text: '' }
        pushChunk({ type: 'block-start', index, blockType: 'reasoning' })
      }
      activeReasoningBlock.text += delta
      pushChunk({ type: 'reasoning-delta', index: activeReasoningBlock.index, text: delta })
    }

    const appendTextDelta = (delta: string) => {
      if (!delta) return
      closeReasoning()
      if (!activeTextBlock) {
        const index = nextBlockIndex++
        activeTextBlock = { index, text: '' }
        pushChunk({ type: 'block-start', index, blockType: 'text' })
      }
      activeTextBlock.text += delta
      pushChunk({ type: 'text-delta', index: activeTextBlock.index, text: delta })
    }

    const closeAllOpenTools = (reason: string) => {
      for (const [id, entry] of openToolCalls.entries()) {
        safeAppendPluginRecord(session, CODEX_TOOL_RECORD_TYPE, {
          phase: 'result',
          turn,
          step,
          callId: entry.callId,
          name: entry.name,
          text: reason,
          isError: true,
        })
        openToolCalls.delete(id)
      }
    }

    const onNotification = (notification: JsonRpcNotification) => {
      const p = notification.params
      const nThread = asString(p.threadId) ?? asString(asObject(p.turn).threadId)
      if (nThread && nThread !== threadId) return
      const nTurn = asString(p.turnId) ?? asString(asObject(p.turn).id)
      if (activeTurnId && nTurn && nTurn !== activeTurnId) return

      switch (notification.method) {
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta': {
          const delta = typeof p.delta === 'string' ? p.delta : ''
          appendReasoningDelta(delta)
          break
        }
        case 'item/agentMessage/delta': {
          const delta = typeof p.delta === 'string' ? p.delta : ''
          appendTextDelta(delta)
          break
        }
        case 'item/started': {
          const item = asObject(p.item)
          const itemType = asString(item.type)
          const itemId = asString(item.id)
          if (!itemId || !itemType) break
          if (itemType === 'commandExecution' || itemType === 'fileChange' || itemType === 'mcpToolCall' || itemType === 'webSearch') {
            const callId = itemId as ToolCallId
            const { toolName, args } = mapToolPresentation(item)
            openToolCalls.set(itemId, { callId, name: toolName })
            safeAppendPluginRecord(session, CODEX_TOOL_RECORD_TYPE, {
              phase: 'start',
              turn,
              step,
              callId,
              name: toolName,
              arguments: JSON.stringify(args),
            })
          }
          break
        }
        case 'item/completed': {
          const item = asObject(p.item)
          const itemType = asString(item.type)
          const itemId = asString(item.id)
          if (!itemId || !itemType) break

          if (itemType === 'agentMessage') {
            const fullText = typeof item.text === 'string' ? item.text : ''
            if (fullText && (!activeTextBlock || activeTextBlock.text.length === 0)) {
              appendTextDelta(fullText)
            }
            closeText()
            break
          }

          if (itemType === 'reasoning') {
            const summary = Array.isArray(item.summary) ? item.summary.map(String).join('\n') : ''
            if (summary && (!activeReasoningBlock || activeReasoningBlock.text.length === 0)) {
              appendReasoningDelta(summary)
            }
            closeReasoning()
            break
          }

          const tracked = openToolCalls.get(itemId)
          if (tracked) {
            openToolCalls.delete(itemId)
            const formatted = formatToolResult(item)
            safeAppendPluginRecord(session, CODEX_TOOL_RECORD_TYPE, {
              phase: 'result',
              turn,
              step,
              callId: tracked.callId,
              name: tracked.name,
              text: formatted.text,
              isError: formatted.isError,
              meta: formatted.meta,
            })
          }
          break
        }
        case 'turn/completed': {
          closeReasoning()
          closeText()
          const turnObj = asObject(p.turn)
          const status = asString(turnObj.status) ?? 'completed'
          if (status === 'failed') {
            closeAllOpenTools('Codex turn failed')
            const errMsg = asString(asObject(turnObj.error).message) ?? 'Codex turn failed'
            pushChunk({
              type: 'finish',
              reason: { kind: 'error', failure: { code: 'UNKNOWN', message: errMsg } },
            })
          } else if (status === 'interrupted') {
            closeAllOpenTools('Codex turn interrupted')
            pushChunk({
              type: 'finish',
              reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Codex turn interrupted' } },
            })
          } else {
            closeAllOpenTools('Codex turn completed')
            pushChunk({ type: 'finish', reason: { kind: 'stop' } })
          }
          done = true
          wakeQueue?.()
          wakeQueue = undefined
          break
        }
        case 'error': {
          const errMsg = asString(asObject(p.error).message) ?? asString(p.message)
          if (errMsg && p.willRetry !== true) {
            closeReasoning()
            closeText()
            closeAllOpenTools(errMsg)
            pushChunk({
              type: 'finish',
              reason: { kind: 'error', failure: { code: 'UNKNOWN', message: errMsg } },
            })
            done = true
            wakeQueue?.()
            wakeQueue = undefined
          }
          break
        }
      }
    }

    const onExit = ({ code }: { code: number | null }) => {
      if (done) return
      streamError = new LlmError(`codex app-server exited unexpectedly (code=${String(code)})`, 'UNKNOWN')
      done = true
      wakeQueue?.()
      wakeQueue = undefined
    }

    const turnEntry: { threadId: string; turnId?: string; cancel: () => void } = {
      threadId,
      cancel: () => {
        if (!done) {
          done = true
          wakeQueue?.()
          wakeQueue = undefined
        }
      },
    }
    this.activeTurns.set(sessionId, turnEntry)
    server.on('notification', onNotification)
    server.on('exit', onExit)

    const onAbort = () => {
      if (activeTurnId) {
        void server.interruptTurn(threadId!, activeTurnId)
      }
      closeAllOpenTools('Turn aborted')
      done = true
      wakeQueue?.()
      wakeQueue = undefined
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const started = await server.startTurn({
        threadId,
        input: promptText,
        cwd,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        approvalPolicy,
        sandboxMode,
      }, options.signal)
      activeTurnId = started.turnId
      turnEntry.turnId = started.turnId

      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!
        }
        if (done) break
        await new Promise<void>((resolve) => {
          wakeQueue = resolve
        })
      }
      if (streamError) throw streamError
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      server.off('notification', onNotification)
      server.off('exit', onExit)
      if (this.activeTurns.get(sessionId) === turnEntry) {
        this.activeTurns.delete(sessionId)
      }
    }
  }
}
