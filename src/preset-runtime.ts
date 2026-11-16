import type { Context } from '@deepseek-ai/cordis'

export const name = 'codex-portal-runtime'
export const inject = ['codexPortal']

export function apply(ctx: Context): void {
  const codex = ctx.get('codexPortal')
  if (codex && typeof codex.registerPresetScope === 'function') {
    codex.registerPresetScope(ctx)
  }
}
