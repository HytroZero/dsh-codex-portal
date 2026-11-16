import type {} from '@deepseek-ai/cordis'

export type ExternalCliSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ExternalCliApprovalPolicy = 'untrusted' | 'on-request' | 'auto-review' | 'never'

export interface EngineConfigControlOption {
  readonly value: string
  readonly label: string
  readonly labelKey?: string
}

export interface EngineConfigControl {
  readonly id: string
  readonly label: string
  readonly labelKey?: string
  readonly defaultValue?: string
  readonly options: readonly EngineConfigControlOption[]
}

export interface ExternalCliModelInfo {
  id: string
  name: string
  description?: string
  reasoningEfforts?: { id: string; name: string; description?: string }[]
  defaultReasoningEffort?: string
}

export interface ExternalCliHealth {
  available: boolean
  binaryPath?: string
  version?: string
  authenticated: boolean
  accountLabel?: string
  errorCode?: 'CLI_NOT_FOUND' | 'CLI_NOT_AUTHENTICATED' | 'CLI_UNHEALTHY'
  message?: string
}

export interface ExternalCliTurnConfig {
  model?: string
  reasoningEffort?: string
  sandboxMode?: ExternalCliSandboxMode
  approvalPolicy?: ExternalCliApprovalPolicy
  engineOptions?: Record<string, string>
  developerInstructions?: string
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
}

export interface ExternalCliApprovalRequest {
  requestId: string
  kind: 'command' | 'file-change' | 'user-input'
  title: string
  detail: string
  options?: { id: string; label: string; description?: string }[]
  resolve: (decision: { approved: boolean; payload?: unknown }) => void
}

export interface ExternalCliEngine {
  readonly id: string
  readonly presetId: string
  readonly label: string
  readonly supportedSandboxes: readonly ExternalCliSandboxMode[]
  readonly supportedApprovals: readonly ExternalCliApprovalPolicy[]
  readonly configControls?: readonly EngineConfigControl[]

  checkHealth(forceRefresh?: boolean): Promise<ExternalCliHealth>
  listModels(forceRefresh?: boolean): Promise<ExternalCliModelInfo[]>
  configureSession(sessionId: string, config: ExternalCliTurnConfig): Promise<void>
  runSessionTurn(params: {
    sessionId: string
    input: string
    config?: ExternalCliTurnConfig
    signal: AbortSignal
    onApprovalRequest?: (req: ExternalCliApprovalRequest) => void
  }): Promise<{ replyText: string; threadId: string }>
  isSessionBusy(sessionId: string): boolean
  cancelSessionTurn(sessionId: string): Promise<void>
  readSessionThreadId(sessionId: string): Promise<string | undefined>
  getSessionConfig?(sessionId: string): ExternalCliTurnConfig | undefined
  resolveApproval?(requestId: string, decision: { approved: boolean; payload?: unknown }): boolean
}

export interface ExternalCliEngineRegistry {
  register(engine: ExternalCliEngine): () => void
  get(idOrPreset: string): ExternalCliEngine | undefined
  list(): ExternalCliEngine[]
  onChange(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    externalCliEngines?: ExternalCliEngineRegistry
  }
}

export function createExternalCliEngineRegistry(): ExternalCliEngineRegistry {
  const engines = new Map<string, ExternalCliEngine>()
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Ignore subscriber errors during registry broadcast.
      }
    }
  }

  return {
    register(engine) {
      engines.set(engine.id, engine)
      notify()
      return () => {
        if (engines.get(engine.id) === engine) {
          engines.delete(engine.id)
          notify()
        }
      }
    },
    get(idOrPreset) {
      const direct = engines.get(idOrPreset)
      if (direct) return direct
      for (const engine of engines.values()) {
        if (engine.presetId === idOrPreset) return engine
      }
      return undefined
    },
    list() {
      return [...engines.values()]
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
