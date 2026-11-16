import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ExternalCliApprovalPolicy,
  ExternalCliModelInfo,
  ExternalCliSandboxMode,
  ExternalCliTurnConfig,
} from './external-cli-contract.js'

export const CODEX_PROVIDER_ID = 'codex-portal'
export const CODEX_PRESET_ID = 'codex-portal'

export interface CodexPluginStoredConfig {
  binaryPath?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  defaultSandboxMode: ExternalCliSandboxMode
  defaultApprovalPolicy: ExternalCliApprovalPolicy
}

export const DEFAULT_CODEX_CONFIG: CodexPluginStoredConfig = {
  defaultSandboxMode: 'workspace-write',
  defaultApprovalPolicy: 'on-request',
}

export class CodexIsolationRegistry {
  private readonly sessionConfigs = new Map<string, ExternalCliTurnConfig>()
  private readonly boundSessions = new Set<string>()

  bindSession(sessionId: string, config?: ExternalCliTurnConfig) {
    this.boundSessions.add(sessionId)
    if (config) {
      this.setSessionConfig(sessionId, config)
    }
  }

  unbindSession(sessionId: string) {
    this.boundSessions.delete(sessionId)
    this.sessionConfigs.delete(sessionId)
  }

  isBound(sessionId: string): boolean {
    return this.boundSessions.has(sessionId)
  }

  getSessionConfig(sessionId: string): ExternalCliTurnConfig | undefined {
    return this.sessionConfigs.get(sessionId)
  }

  setSessionConfig(sessionId: string, patch: ExternalCliTurnConfig) {
    const prev = this.sessionConfigs.get(sessionId) ?? {}
    this.sessionConfigs.set(sessionId, {
      ...prev,
      ...patch,
    })
  }

  isCodexAgent(agent: Agent): boolean {
    if (this.boundSessions.has(agent.id)) return true
    const presetService = agent.ctx.root.get('agentPresets') as {
      composedPreset?(ctx: unknown): string | undefined
    } | undefined
    if (presetService?.composedPreset?.(agent.ctx) === CODEX_PRESET_ID) return true
    if (agent.session.header.agentPreset === CODEX_PRESET_ID) return true
    return false
  }
}

export function pickDefaultCodexSelection(
  models: readonly ExternalCliModelInfo[],
  config: CodexPluginStoredConfig,
  sessionConfig?: ExternalCliTurnConfig,
): ModelSelection | undefined {
  const preferredId = sessionConfig?.model ?? config.defaultModel
  const matched = (preferredId ? models.find(m => m.id === preferredId) : undefined) ?? models[0]
  if (!matched) {
    const fallbackModel = preferredId ?? 'codex-default'
    const effort = sessionConfig?.reasoningEffort ?? config.defaultReasoningEffort
    return {
      provider: CODEX_PROVIDER_ID,
      model: fallbackModel,
      ...(effort ? { reasoningEffort: effort as ReasoningEffortId } : {}),
    }
  }
  const preferredEffort = sessionConfig?.reasoningEffort ?? config.defaultReasoningEffort
  const validEffort = preferredEffort && matched.reasoningEfforts?.some(e => e.id === preferredEffort)
    ? preferredEffort
    : matched.defaultReasoningEffort ?? matched.reasoningEfforts?.[0]?.id
  return {
    provider: CODEX_PROVIDER_ID,
    model: matched.id,
    ...(validEffort ? { reasoningEffort: validEffort as ReasoningEffortId } : {}),
  }
}

export function ensureCodexModelSelection(
  agent: Agent,
  models: readonly ExternalCliModelInfo[],
  config: CodexPluginStoredConfig,
  sessionConfig?: ExternalCliTurnConfig,
): ModelSelection | undefined {
  const current = agent.model.current()
  if (current?.provider === CODEX_PROVIDER_ID && current.model) {
    return current
  }
  const fallback = pickDefaultCodexSelection(models, config, sessionConfig)
  if (fallback) {
    agent.model.select(fallback)
    return fallback
  }
  return undefined
}

export function assertModeModelIsolation(options: {
  agent: Agent
  selection: ModelSelection
  isCodexSession: boolean
  models?: readonly ExternalCliModelInfo[]
}) {
  const { selection, isCodexSession, models } = options
  if (isCodexSession) {
    if (selection.provider !== CODEX_PROVIDER_ID) {
      throw new LlmError(
        `Codex Portal mode only accepts "${CODEX_PROVIDER_ID}" models (received "${selection.provider}/${selection.model}").`,
        'INVALID_REQUEST',
      )
    }
    if (models && models.length > 0 && selection.model !== 'codex-default' && !models.some(m => m.id === selection.model)) {
      throw new LlmError(
        `Model "${selection.model}" is not available in your local Codex CLI.`,
        'INVALID_REQUEST',
      )
    }
    return
  }

  if (selection.provider === CODEX_PROVIDER_ID) {
    throw new LlmError(
      'Codex Portal models cannot be used outside Codex Portal mode or Codex-bound DeepDuet sessions.',
      'NO_ADAPTER',
    )
  }
}
