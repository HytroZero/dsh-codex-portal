import { StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { useState } from 'react'
import styles from './CodexPortal.module.css'
import type { CodexPortalLocaleKey, NS } from './locales'

export interface CodexToolViewInjected {
  readonly t: TranslateNS<typeof NS>
}

type CodexToolViewProps = PropsRuntime<'tool.call.toolview', string> & CodexToolViewInjected

const TOOL_LABELS: Record<string, CodexPortalLocaleKey> = {
  codex_command: 'tool.command',
  codex_file_change: 'tool.fileChange',
  codex_mcp_tool: 'tool.mcpTool',
  codex_web_search: 'tool.webSearch',
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

export function CodexToolView({ block, phase, t }: CodexToolViewProps) {
  const [expanded, setExpanded] = useState(false)
  const record = block as unknown as Record<string, unknown>
  const args = asRecord(record.input) ?? asRecord(record.args) ?? {}
  const meta = asRecord(record.meta)
  const isError = Boolean(record.isError)

  const titleKey = TOOL_LABELS[block.name] ?? 'tool.command'
  const subtitle = typeof args.command === 'string'
    ? args.command
    : typeof args.query === 'string'
      ? args.query
      : typeof args.tool === 'string'
        ? `${String(args.server ?? '')}.${args.tool}`
        : Array.isArray(args.paths)
          ? args.paths.join(', ')
          : ''

  const detailText = typeof meta?.output === 'string'
    ? meta.output
    : Array.isArray(meta?.changes)
      ? (meta.changes as Array<Record<string, unknown>>)
        .map(c => `${String(c.kind ?? 'update')} ${String(c.path ?? '')}${c.diff ? `\n${String(c.diff)}` : ''}`)
        .join('\n\n')
      : Array.isArray(record.content)
        ? (record.content as Array<Record<string, unknown>>).map(b => String(b.text ?? '')).filter(Boolean).join('\n')
        : typeof record.text === 'string'
          ? record.text
          : ''

  return (
    <div className={styles.toolCard}>
      <div className={styles.toolHeader} onClick={() => setExpanded(v => !v)}>
        <div className={styles.toolTitle}>
          <StateDot state={phase !== 'result' ? 'ongoing' : isError ? 'warning' : 'done'} />
          <span>{t(titleKey)}</span>
          {subtitle && <span>· {subtitle}</span>}
        </div>
        <Tag tone={phase !== 'result' ? 'info' : isError ? 'danger' : 'success'}>
          {phase !== 'result' ? t('tool.running') : isError ? t('tool.failed') : t('tool.completed')}
        </Tag>
      </div>
      {expanded && detailText && (
        <pre className={styles.toolPre}>{detailText}</pre>
      )}
    </div>
  )
}
