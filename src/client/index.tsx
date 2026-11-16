import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { IconDataOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CodexModelControl } from './CodexModelControl'
import { CodexSettingsSection } from './CodexSettingsSection'
import { CodexToolView } from './CodexToolViews'
import { NS, en, zh } from './locales'
import { createCodexPortalStore } from './store'

export { createCodexPortalStore, useCodexPortalSelector } from './store'
export type { CodexPortalClientStore, CodexPortalStoreState } from './store'

export const inject = [
  'remote',
  'locale',
  'slots',
] as const

const CODEX_TOOLS = ['codex_command', 'codex_file_change', 'codex_mcp_tool', 'codex_web_search'] as const

export function apply(ctx: Context): void {
  const store = createCodexPortalStore(ctx)
  ctx.effect(() => store.start(), 'codex-portal: remote watch store')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'codex-portal: locales')
  const t = ctx.locale.bind(NS)

  const registerSlot = <K extends keyof import('@deepseek-ai/dsh-client-ui-slots').SlotMap & string>(
    spec: Record<string, unknown> & { name: K },
    component: (props: any) => any,
    label: string,
  ) => {
    const slots = ctx.slots as unknown as {
      inject?: (name: K, cb: () => () => void) => () => void
      register: (spec: Record<string, unknown>, component: (props: any) => any) => () => void
    }
    ctx.effect(
      () => (typeof slots.inject === 'function'
        ? slots.inject(spec.name, () => slots.register(spec, component))
        : slots.register(spec, component)),
      label,
    )
  }

  const injectBase = () => ({
    hooks: { codexPortal: store.snapshot },
    store,
    t,
  })

  registerSlot(
    {
      name: 'settings.section',
      id: 'codex-portal',
      order: 25,
      label: () => t('settings.nav'),
      locale: NS,
      inject: injectBase,
    },
    (props: PropsRuntime<'settings.section'>) => <CodexSettingsSection store={store} t={t} {...props} />,
    'codex-portal: settings section',
  )

  registerSlot(
    {
      name: 'conversation.input.right',
      id: 'codex-portal-model',
      order: 50,
      locale: NS,
      inject: injectBase,
    },
    (props: PropsRuntime<'conversation.input.right'>) => <CodexModelControl store={store} t={t} {...props} />,
    'codex-portal: input model control',
  )

  for (const toolKey of CODEX_TOOLS) {
    registerSlot(
      {
        name: 'tool.call.toolview',
        key: toolKey,
        locale: NS,
        inject: () => ({ t }),
      },
      (props: PropsRuntime<'tool.call.toolview', typeof toolKey>) => <CodexToolView t={t} {...props} />,
      `codex-portal: toolview ${toolKey}`,
    )
  }

  ctx.inject(['uiConversation'], (convCtx) => {
    const uiConv = convCtx.get('uiConversation') as {
      events?: { register(def: unknown): () => void }
    } | undefined
    if (!uiConv?.events?.register) return
    convCtx.effect(() => uiConv.events!.register({
      kind: 'tool',
      target: 'chat',
      match: {
        'plugin:codex-portal/tool': (event: { data?: Record<string, unknown> }) => {
          const data = event.data
          if (!data || typeof data.callId !== 'string') return null
          return {
            id: `codex-tool:${data.callId}`,
            role: data.phase === 'result' ? 'update' : 'start',
          }
        },
      },
      start: (_context: unknown, match: { event: { seq: number; time: number; data: Record<string, unknown> } }) => {
        const d = match.event.data
        const argsRaw = typeof d.arguments === 'string' ? d.arguments : '{}'
        let parsedArgs: Record<string, unknown> = {}
        try { parsedArgs = JSON.parse(argsRaw) as Record<string, unknown> } catch {}
        return {
          root: {
            phase: 'start',
            callId: String(d.callId),
            name: String(d.name ?? 'codex_command'),
            argsRaw,
            args: {
              object: parsedArgs,
              closed: () => true,
              keys: () => Object.keys(parsedArgs),
              has: (k: string) => Object.hasOwn(parsedArgs, k),
              complete: (k: string) => Object.hasOwn(parsedArgs, k),
              text: (k: string) => (typeof parsedArgs[k] === 'string' ? parsedArgs[k] : undefined),
              value: (k: string) => parsedArgs[k],
            },
            seq: match.event.seq,
            time: match.event.time,
          },
          children: new Map(),
          parents: new Map(),
        }
      },
      update: (context: { state: { root?: Record<string, unknown>; children: Map<unknown, unknown>; parents: Map<unknown, unknown> } }, match: { event: { seq: number; time: number; data: Record<string, unknown> } }) => {
        const d = match.event.data
        if (d.phase !== 'result') return context.state
        const prev = context.state.root ?? {}
        return {
          ...context.state,
          root: {
            kind: 'tool-result',
            seq: match.event.seq,
            time: match.event.time,
            callId: String(d.callId),
            name: String(d.name ?? prev.name ?? 'codex_command'),
            args: prev.args ?? { object: {}, closed: () => true, keys: () => [], has: () => false, complete: () => false, text: () => undefined, value: () => undefined },
            call: prev.name ? { name: prev.name, argsRaw: prev.argsRaw ?? '{}' } : null,
            callTime: prev.time ?? null,
            content: [{ type: 'text', text: String(d.text ?? '') }],
            isError: d.isError === true,
            meta: d.meta,
            subCalls: [],
          },
        }
      },
    }), 'codex-portal: project plugin:codex-portal/tool into chat timeline')
  })

  ctx.inject(['commandUi', 'sessions'], (scope) => {
    const command = scope.get('commandUi') as {
      register?: (entry: unknown) => () => void
    } | undefined
    const sessions = scope.get('sessions') as {
      binding(id: string): { session: { projections: { faceOf(key: string): { getSnapshot(): unknown } } } } | undefined
    } | undefined
    if (!command?.register || !sessions) return

    scope.effect(() => command.register!({
      name: 'codex-model',
      label: () => t('command.modelLabel'),
      description: () => t('command.modelDesc'),
      icon: IconDataOutlineRegular,
      available: (session: { sessionId: string }) => {
        const snap = store.snapshot.getSnapshot()
        if (snap.sessions[session.sessionId]?.isCodexSession) return true
        const preset = sessions.binding(session.sessionId)?.session.projections.faceOf('agentPreset').getSnapshot()
        return preset === 'codex-portal'
      },
      ui: {
        kind: 'popupSelect',
        searchMode: 'fuzzy-label',
        options: async () => {
          const snap = store.snapshot.getSnapshot()
          return snap.models.map(m => ({
            id: m.id,
            label: m.name,
            description: m.description ?? m.id,
          }))
        },
        onSelect: async (option: { id: string }, session: { sessionId: string }) => {
          await store.selectSessionModel({
            sessionId: session.sessionId,
            model: option.id,
          })
        },
      },
    }), 'codex-portal: /codex-model command')
  })
}
