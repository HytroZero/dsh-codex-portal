import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { useEffect } from 'react'
import { useCodexPortalSelector, type CodexPortalClientStore, type CodexPortalStoreState } from './store'

export interface CodexModelProjectionValue {
  next?: { provider?: string; model?: string; reasoningEffort?: string } | null
  lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null
}

/**
 * Shared selector & session-info hydration for Codex composer controls
 * (`conversation.input.left` and `conversation.input.right`).
 */
export function useCodexSessionControl(options: {
  store: CodexPortalClientStore
  sessionId: string
  useSessions?: (selector: (state: any) => any) => any
  useCodexPortal?: SnapshotSelectorHook<CodexPortalStoreState>
}) {
  const { store, sessionId, useSessions, useCodexPortal } = options
  const health = useCodexPortalSelector(store, s => s.health, undefined, useCodexPortal)
  const models = useCodexPortalSelector(store, s => s.models, undefined, useCodexPortal)
  const config = useCodexPortalSelector(store, s => s.config, undefined, useCodexPortal)
  const sessionInfo = useCodexPortalSelector(store, s => s.sessions[sessionId], undefined, useCodexPortal)

  const sessionSummary = typeof useSessions === 'function'
    ? useSessions(state => state.byId[sessionId])
    : undefined

  const preset = typeof sessionSummary?.projectionValues?.agentPreset === 'string'
    ? sessionSummary.projectionValues.agentPreset
    : undefined
  const modelProj = sessionSummary?.projectionValues?.modelSelection as CodexModelProjectionValue | undefined

  const currentSelection = modelProj?.next ?? modelProj?.lastUsed
  const isCodexActive = preset === 'codex-portal'
    || currentSelection?.provider === 'codex-portal'
    || sessionInfo?.isCodexSession === true

  useEffect(() => {
    if (!sessionId) return
    void store.fetchSessionInfo(sessionId).catch(() => {})
  }, [store, sessionId, preset, currentSelection?.provider, currentSelection?.model])

  return {
    health,
    models,
    config,
    sessionInfo,
    currentSelection,
    isCodexActive,
  }
}
