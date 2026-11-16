import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { buildCodexSpawnSpec } from './codex-binary.js'
import type {
  ExternalCliApprovalPolicy,
  ExternalCliModelInfo,
  ExternalCliSandboxMode,
} from './external-cli-contract.js'

export interface JsonRpcServerRequest {
  id: string | number
  method: string
  params: Record<string, unknown>
}

export interface JsonRpcNotification {
  method: string
  params: Record<string, unknown>
}

export interface CodexServerConfig {
  binaryPath: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  onWarn?: (message: string) => void
}

export interface CodexTurnStartParams {
  threadId: string
  input: string
  cwd?: string
  model?: string
  effort?: string
  approvalPolicy?: ExternalCliApprovalPolicy
  sandboxMode?: ExternalCliSandboxMode
}

export interface CodexThreadParams {
  cwd: string
  model?: string
  approvalPolicy?: ExternalCliApprovalPolicy
  sandboxMode?: ExternalCliSandboxMode
  developerInstructions?: string
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function mapSandboxPolicy(mode: ExternalCliSandboxMode, cwd?: string): Record<string, unknown> {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly' }
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    case 'workspace-write':
    default:
      return {
        type: 'workspaceWrite',
        ...(cwd ? { writableRoots: [cwd] } : {}),
        networkAccess: false,
      }
  }
}

export class CodexAppServerError extends Error {
  constructor(readonly code: string | number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CodexAppServerError'
  }
}

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined
  private connectPromise: Promise<void> | undefined
  private nextId = 1
  private pending = new Map<string | number, PendingRpc>()
  private serverRequestHandler: ((req: JsonRpcServerRequest) => Promise<unknown>) | undefined
  private closed = false
  private binaryPath: string

  constructor(private readonly options: CodexServerConfig) {
    super()
    this.binaryPath = options.binaryPath
  }

  setBinaryPath(binaryPath: string) {
    if (this.binaryPath !== binaryPath) {
      this.binaryPath = binaryPath
      void this.restart()
    }
  }

  setServerRequestHandler(handler: (req: JsonRpcServerRequest) => Promise<unknown>) {
    this.serverRequestHandler = handler
  }

  async ensureConnected(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new CodexAppServerError('CLIENT_CLOSED', 'Codex app-server client is closed')
    if (this.child && !this.child.killed && this.child.exitCode === null && this.connectPromise) {
      return this.connectPromise
    }
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = this.startProcess(signal).catch((error) => {
      this.connectPromise = undefined
      throw error
    })
    return this.connectPromise
  }

  private async startProcess(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const baseArgs = this.options.args ?? ['app-server']
    const spec = await buildCodexSpawnSpec(this.binaryPath, baseArgs)
    const child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.options.env ?? process.env,
      shell: false,
      windowsHide: true,
    })
    this.child = child

    const stderrTail: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim()
      if (!line) return
      stderrTail.push(line)
      if (stderrTail.length > 20) stderrTail.shift()
    })

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg: Record<string, unknown>
      try {
        msg = asObject(JSON.parse(trimmed))
      } catch {
        this.options.onWarn?.(`codex app-server emitted non-JSON line: ${trimmed.slice(0, 120)}`)
        return
      }
      this.handleIncoming(msg)
    })

    child.once('error', (error) => {
      this.failAllPending(new CodexAppServerError('PROCESS_ERROR', error.message, { cause: error }))
      this.cleanupChild(child)
    })

    child.once('exit', (code, sig) => {
      rl.close()
      const detail = stderrTail.slice(-3).join(' | ')
      const reason = `codex app-server exited (code=${String(code)}, signal=${String(sig)})${detail ? `: ${detail}` : ''}`
      this.failAllPending(new CodexAppServerError('PROCESS_EXITED', reason))
      this.cleanupChild(child)
      this.emit('exit', { code, signal: sig })
    })

    await this.sendRawRequest('initialize', {
      clientInfo: {
        name: 'dsh-codex-portal',
        title: 'DeepSeek Harness Codex Portal',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }, signal)
    this.sendRawNotification('initialized', {})
  }

  private cleanupChild(child: ChildProcessWithoutNullStreams) {
    if (this.child === child) {
      this.child = undefined
      this.connectPromise = undefined
    }
  }

  private failAllPending(error: Error) {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private handleIncoming(msg: Record<string, unknown>) {
    const id = msg.id
    const method = typeof msg.method === 'string' ? msg.method : undefined

    // Server-initiated request (has both id and method)
    if (method && (typeof id === 'string' || typeof id === 'number')) {
      const req: JsonRpcServerRequest = {
        id,
        method,
        params: asObject(msg.params),
      }
      void this.dispatchServerRequest(req)
      return
    }

    // Response to our request
    if ((typeof id === 'string' || typeof id === 'number') && !method) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      if (msg.error !== undefined) {
        const errObj = asObject(msg.error)
        const code = typeof errObj.code === 'number' || typeof errObj.code === 'string' ? errObj.code : 'RPC_ERROR'
        const message = typeof errObj.message === 'string' ? errObj.message : JSON.stringify(msg.error)
        pending.reject(new CodexAppServerError(code, message))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    // Notification
    if (method) {
      this.emit('notification', {
        method,
        params: asObject(msg.params),
      } satisfies JsonRpcNotification)
    }
  }

  private async dispatchServerRequest(req: JsonRpcServerRequest) {
    if (!this.serverRequestHandler) {
      this.sendRawResponse(req.id, undefined, { code: -32601, message: `No handler for ${req.method}` })
      return
    }
    try {
      const result = await this.serverRequestHandler(req)
      this.sendRawResponse(req.id, result ?? {})
    } catch (error) {
      this.sendRawResponse(req.id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private writeLine(payload: Record<string, unknown>) {
    const child = this.child
    if (!child || !child.stdin.writable) {
      throw new CodexAppServerError('NOT_CONNECTED', 'codex app-server stdin is not writable')
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private sendRawNotification(method: string, params: Record<string, unknown>) {
    this.writeLine({ method, params })
  }

  private sendRawResponse(id: string | number, result?: unknown, error?: { code: number; message: string }) {
    if (!this.child || !this.child.stdin.writable) return
    this.writeLine(error ? { id, error } : { id, result: result ?? {} })
  }

  private sendRawRequest(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Aborted')))
    }
    const id = this.nextId++
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        if (this.pending.delete(id)) {
          cleanup()
          reject(signal?.reason instanceof Error ? signal.reason : new Error('RPC request aborted'))
        }
      }
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (this.pending.delete(id)) {
          cleanup()
          reject(new CodexAppServerError('RPC_TIMEOUT', `codex app-server request "${method}" timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs) : undefined
      timer?.unref?.()

      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        timer,
      })
      try {
        this.writeLine({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    await this.ensureConnected(signal)
    return (await this.sendRawRequest(method, params, signal)) as T
  }

  async listModels(signal?: AbortSignal): Promise<ExternalCliModelInfo[]> {
    const models: ExternalCliModelInfo[] = []
    let cursor: string | undefined
    do {
      const res = await this.request<{
        data?: Array<{
          id?: string
          model?: string
          displayName?: string
          description?: string
          defaultReasoningEffort?: string
          supportedReasoningEfforts?: Array<{ reasoningEffort?: string; description?: string }>
        }>
        nextCursor?: string | null
      }>('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      }, signal)

      for (const item of res.data ?? []) {
        const id = item.model ?? item.id
        if (!id) continue
        const efforts = (item.supportedReasoningEfforts ?? [])
          .filter(e => typeof e.reasoningEffort === 'string' && e.reasoningEffort.length > 0)
          .map(e => ({
            id: e.reasoningEffort!,
            name: e.reasoningEffort!,
            ...(e.description ? { description: e.description } : {}),
          }))
        models.push({
          id,
          name: item.displayName || id,
          ...(item.description ? { description: item.description } : {}),
          ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
          ...(item.defaultReasoningEffort ? { defaultReasoningEffort: item.defaultReasoningEffort } : {}),
        })
      }
      cursor = typeof res.nextCursor === 'string' && res.nextCursor.length > 0 ? res.nextCursor : undefined
    } while (cursor)

    return models
  }

  async readAccount(signal?: AbortSignal): Promise<{ authenticated: boolean; accountLabel?: string }> {
    const res = await this.request<{
      account?: { type?: string; email?: string; planType?: string } | null
      requiresOpenaiAuth?: boolean
    }>('account/read', { refreshToken: false }, signal)
    if (!res.account) {
      return { authenticated: false }
    }
    const parts = [res.account.email, res.account.planType, res.account.type].filter(Boolean)
    return {
      authenticated: true,
      ...(parts.length > 0 ? { accountLabel: parts.join(' · ') } : {}),
    }
  }

  private buildConfigOverride(mcpServers?: CodexThreadParams['mcpServers']): Record<string, unknown> | undefined {
    if (!mcpServers || Object.keys(mcpServers).length === 0) return undefined
    return {
      mcp_servers: Object.fromEntries(
        Object.entries(mcpServers).map(([name, spec]) => [name, {
          command: spec.command,
          args: spec.args,
          ...(spec.env ? { env: spec.env } : {}),
        }]),
      ),
    }
  }

  async startThread(params: CodexThreadParams, signal?: AbortSignal): Promise<{ threadId: string }> {
    const config = this.buildConfigOverride(params.mcpServers)
    const res = await this.request<{ thread?: { id?: string } }>('thread/start', {
      cwd: params.cwd,
      ...(params.model ? { model: params.model } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      ...(params.sandboxMode ? { sandbox: params.sandboxMode } : {}),
      ...(params.developerInstructions ? { developerInstructions: params.developerInstructions } : {}),
      ...(config ? { config } : {}),
    }, signal)
    const threadId = res.thread?.id
    if (!threadId) throw new CodexAppServerError('INVALID_RESPONSE', 'thread/start returned no thread.id')
    return { threadId }
  }

  async resumeThread(threadId: string, params: CodexThreadParams, signal?: AbortSignal): Promise<{ threadId: string }> {
    const config = this.buildConfigOverride(params.mcpServers)
    const res = await this.request<{ thread?: { id?: string } }>('thread/resume', {
      threadId,
      cwd: params.cwd,
      ...(params.model ? { model: params.model } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      ...(params.sandboxMode ? { sandbox: params.sandboxMode } : {}),
      ...(params.developerInstructions ? { developerInstructions: params.developerInstructions } : {}),
      ...(config ? { config } : {}),
    }, signal)
    return { threadId: res.thread?.id ?? threadId }
  }

  async startTurn(params: CodexTurnStartParams, signal?: AbortSignal): Promise<{ turnId: string }> {
    const res = await this.request<{ turn?: { id?: string } }>('turn/start', {
      threadId: params.threadId,
      input: [{ type: 'text', text: params.input }],
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      ...(params.sandboxMode ? { sandboxPolicy: mapSandboxPolicy(params.sandboxMode, params.cwd) } : {}),
    }, signal)
    const turnId = res.turn?.id
    if (!turnId) throw new CodexAppServerError('INVALID_RESPONSE', 'turn/start returned no turn.id')
    return { turnId }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId }, AbortSignal.timeout(5_000)).catch(() => {})
  }

  async restart(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.connectPromise = undefined
    if (child && child.exitCode === null) {
      child.kill()
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 1_500)
        timer.unref?.()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.failAllPending(new CodexAppServerError('CLIENT_CLOSED', 'Codex app-server client closed'))
    await this.restart()
  }
}
