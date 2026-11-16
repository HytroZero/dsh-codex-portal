import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, shallowEqual, type SnapshotSelectorHook, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { useRef, useSyncExternalStore } from 'react'
import { z } from 'zod'
import type {
  ExternalCliHealth,
  ExternalCliModelInfo,
} from '../external-cli-contract'
import {
  createCodexPortalRemoteInfo,
  type CodexPortalSelectModelParams,
  type CodexPortalSessionConfigParams,
  type CodexPortalSessionInfo,
  type CodexPortalStatusSnapshot,
  type CodexPortalStoredSettings,
} from '../remote'

export interface CodexPortalStoreState {
  ready: boolean
  checking: boolean
  saving: boolean
  health: ExternalCliHealth | undefined
  models: ExternalCliModelInfo[]
  config: CodexPortalStoredSettings
  sessions: Record<string, CodexPortalSessionInfo>
  error: string | undefined
}

interface CodexPortalRemoteNamespace {
  status(): Promise<RemoteResult<CodexPortalStatusSnapshot>>
  checkHealth(): Promise<RemoteResult<CodexPortalStatusSnapshot>>
  watch(signal?: AbortSignal): AsyncIterable<CodexPortalStatusSnapshot>
  setConfig(input: Partial<CodexPortalStoredSettings>): Promise<RemoteResult<CodexPortalStatusSnapshot>>
  sessionInfo(sessionId: string): Promise<RemoteResult<CodexPortalSessionInfo>>
  selectModel(input: CodexPortalSelectModelParams): Promise<RemoteResult<CodexPortalSessionInfo>>
  setSessionConfig(input: CodexPortalSessionConfigParams): Promise<RemoteResult<CodexPortalSessionInfo>>
}

interface MountableRemote {
  $mount(contribution: { package: string; descriptors: readonly unknown[] }): Promise<void>
  codexPortal?: CodexPortalRemoteNamespace
}

export interface CodexPortalClientStore {
  readonly snapshot: SnapshotStore<CodexPortalStoreState>
  start(): () => void
  refresh(): Promise<void>
  checkHealth(): Promise<CodexPortalStatusSnapshot>
  setConfig(patch: Partial<CodexPortalStoredSettings>): Promise<CodexPortalStatusSnapshot>
  fetchSessionInfo(sessionId: string): Promise<CodexPortalSessionInfo>
  selectSessionModel(input: CodexPortalSelectModelParams): Promise<CodexPortalSessionInfo>
  setSessionConfig(input: CodexPortalSessionConfigParams): Promise<CodexPortalSessionInfo>
}

const INITIAL_STATE: CodexPortalStoreState = {
  ready: false,
  checking: false,
  saving: false,
  health: undefined,
  models: [],
  config: {
    defaultSandboxMode: 'workspace-write',
    defaultApprovalPolicy: 'on-request',
  },
  sessions: {},
  error: undefined,
}

async function unwrapResult<T>(pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) {
    const failure: RemoteFailure = result.error
    throw new Error(failure.message || failure.code)
  }
  return result.value
}

export function createCodexPortalStore(ctx: Context): CodexPortalClientStore {
  const store = createSnapshotStore<CodexPortalStoreState>(INITIAL_STATE)
  let remotePromise: Promise<CodexPortalRemoteNamespace> | undefined
  let disposed = false

  function readNamespace(): CodexPortalRemoteNamespace | undefined {
    if (typeof ctx.get === 'function') {
      return ctx.get('remote.codexPortal') as CodexPortalRemoteNamespace | undefined
    }
    return (ctx.remote as unknown as MountableRemote).codexPortal
  }

  async function ensureRemote(): Promise<CodexPortalRemoteNamespace> {
    const existing = readNamespace()
    if (existing) return existing
    remotePromise ??= (async () => {
      const mountable = ctx.remote as unknown as MountableRemote
      const info = createCodexPortalRemoteInfo(z)
      await mountable.$mount({
        package: 'dsh-codex-portal',
        descriptors: info.descriptors,
      })
      const api = readNamespace()
      if (!api) throw new Error('Failed to mount codexPortal remote namespace')
      return api
    })()
    try {
      return await remotePromise
    } catch (error) {
      remotePromise = undefined
      throw error
    }
  }

  function applyStatus(data: CodexPortalStatusSnapshot) {
    store.update((draft) => {
      draft.ready = true
      draft.health = data.health
      draft.models = [...data.models]
      draft.config = { ...data.config }
      draft.error = undefined
    })
  }

  async function refresh() {
    const api = await ensureRemote()
    const snap = await unwrapResult(api.status())
    if (!disposed) applyStatus(snap)
  }

  function start(): () => void {
    disposed = false
    let activeStream: { dispose(): Promise<void> } | undefined
    void (async () => {
      try {
        const api = await ensureRemote()
        if (disposed) return
        void refresh().catch(() => {})
        const stream = ctx.remote.$stream<CodexPortalStatusSnapshot>({
          name: 'codexPortal/watch',
          open: signal => api.watch(signal),
          ended: accepted => new Error(accepted ? 'codexPortal/watch ended' : 'codexPortal/watch ended before snapshot'),
        })
        activeStream = stream
        if (disposed) {
          await stream.dispose()
          return
        }
        for await (const item of stream) {
          item.accept()
          if (disposed) break
          applyStatus(item.value)
        }
      } catch (error) {
        if (!disposed) {
          store.update((draft) => {
            draft.error = error instanceof Error ? error.message : String(error)
          })
        }
      }
    })()
    return () => {
      disposed = true
      void activeStream?.dispose()
    }
  }

  return {
    snapshot: store,
    start,
    refresh,
    async checkHealth() {
      store.update((draft) => {
        draft.checking = true
        draft.error = undefined
      })
      try {
        const api = await ensureRemote()
        const snap = await unwrapResult(api.checkHealth())
        applyStatus(snap)
        return snap
      } catch (error) {
        store.update((draft) => {
          draft.error = error instanceof Error ? error.message : String(error)
        })
        throw error
      } finally {
        store.update((draft) => {
          draft.checking = false
        })
      }
    },
    async setConfig(patch) {
      store.update((draft) => {
        draft.saving = true
        draft.error = undefined
      })
      try {
        const api = await ensureRemote()
        const snap = await unwrapResult(api.setConfig(patch))
        applyStatus(snap)
        return snap
      } catch (error) {
        store.update((draft) => {
          draft.error = error instanceof Error ? error.message : String(error)
        })
        throw error
      } finally {
        store.update((draft) => {
          draft.saving = false
        })
      }
    },
    async fetchSessionInfo(sessionId) {
      const api = await ensureRemote()
      const info = await unwrapResult(api.sessionInfo(sessionId))
      store.update((draft) => {
        draft.sessions[sessionId] = info
      })
      return info
    },
    async selectSessionModel(input) {
      const api = await ensureRemote()
      const info = await unwrapResult(api.selectModel(input))
      store.update((draft) => {
        draft.sessions[input.sessionId] = info
      })
      return info
    },
    async setSessionConfig(input) {
      const api = await ensureRemote()
      const info = await unwrapResult(api.setSessionConfig(input))
      store.update((draft) => {
        draft.sessions[input.sessionId] = info
      })
      return info
    },
  }
}

export function useCodexPortalSelector<S>(
  store: CodexPortalClientStore,
  selector: (state: CodexPortalStoreState) => S,
  isEqual: (a: S, b: S) => boolean = shallowEqual,
  useCodexPortal?: SnapshotSelectorHook<CodexPortalStoreState>,
): S {
  if (useCodexPortal) return useCodexPortal(selector, isEqual)
  const lastRef = useRef<{ hasValue: boolean; value: S }>({
    hasValue: false,
    value: undefined as S,
  })
  return useSyncExternalStore(
    store.snapshot.subscribe,
    () => {
      const next = selector(store.snapshot.getSnapshot())
      if (lastRef.current.hasValue && isEqual(lastRef.current.value, next)) {
        return lastRef.current.value
      }
      lastRef.current = { hasValue: true, value: next }
      return next
    },
    () => selector(INITIAL_STATE),
  )
}
