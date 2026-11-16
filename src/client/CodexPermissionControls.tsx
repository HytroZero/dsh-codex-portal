import {
  IconCheckCircleOutlineRegular,
  IconChevronDownOutlineRegular,
  IconShieldOutlineRegular,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'
import type { ExternalCliApprovalPolicy, ExternalCliSandboxMode } from '../external-cli-contract'
import styles from './CodexPortal.module.css'
import type { NS } from './locales'
import type { CodexPortalClientStore, CodexPortalStoreState } from './store'
import { useCodexSessionControl } from './useCodexSession'

export interface CodexPermissionControlsInjected {
  readonly store: CodexPortalClientStore
  readonly t: TranslateNS<typeof NS>
  readonly useCodexPortal?: SnapshotSelectorHook<CodexPortalStoreState>
}

type CodexPermissionControlsProps = PropsRuntime<'conversation.input.left'> & CodexPermissionControlsInjected

const SANDBOX_LABEL_KEYS = {
  'read-only': { short: 'sandbox.short.readOnly', full: 'sandbox.readOnly' },
  'workspace-write': { short: 'sandbox.short.workspaceWrite', full: 'sandbox.workspaceWrite' },
  'danger-full-access': { short: 'sandbox.short.dangerFullAccess', full: 'sandbox.dangerFullAccess' },
} as const

const APPROVAL_LABEL_KEYS = {
  'on-request': { short: 'approval.short.onRequest', full: 'approval.onRequest' },
  'auto-review': { short: 'approval.short.autoReview', full: 'approval.autoReview' },
  'untrusted': { short: 'approval.short.untrusted', full: 'approval.untrusted' },
  'never': { short: 'approval.short.never', full: 'approval.never' },
} as const

export function CodexPermissionControls({
  store,
  t,
  useCodexPortal,
  useSessions,
  sessionId,
}: CodexPermissionControlsProps) {
  const { config, sessionInfo, isCodexActive } = useCodexSessionControl({
    store,
    sessionId,
    useSessions,
    useCodexPortal,
  })

  const [sandboxOpen, setSandboxOpen] = useState(false)
  const [approvalOpen, setApprovalOpen] = useState(false)

  if (!isCodexActive) return null

  const activeSandbox: ExternalCliSandboxMode = sessionInfo?.sandboxMode ?? config.defaultSandboxMode
  const activeApproval: ExternalCliApprovalPolicy = sessionInfo?.approvalPolicy ?? config.defaultApprovalPolicy
  const busy = sessionInfo?.busy === true

  const sandboxLabel = t(SANDBOX_LABEL_KEYS[activeSandbox].short)
  const approvalLabel = t(APPROVAL_LABEL_KEYS[activeApproval].short)
  const isDangerSandbox = activeSandbox === 'danger-full-access'

  return (
    <div className={styles.permissionSeat} data-codex-permission-seat="active">
      <Menu
        open={sandboxOpen && !busy}
        onClose={() => setSandboxOpen(false)}
        items={[
          { type: 'label', id: 'sandbox-heading', text: t('model.sandbox') },
          { id: 'read-only', label: t('sandbox.readOnly') },
          { id: 'workspace-write', label: t('sandbox.workspaceWrite') },
          { id: 'danger-full-access', label: t('sandbox.dangerFullAccess') },
        ]}
        selectedId={activeSandbox}
        onSelect={(id) => {
          setSandboxOpen(false)
          if (id === activeSandbox) return
          void store.setSessionConfig({
            sessionId,
            sandboxMode: id as ExternalCliSandboxMode,
          }).catch(() => {})
        }}
        align="start"
        side="top"
        portal
        dense
        listClassName={styles.selectMenuList}
        anchor={(
          <button
            type="button"
            className={`${styles.permissionTrigger} ${isDangerSandbox ? styles.permissionTriggerWarn : ''}`}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={sandboxOpen && !busy}
            title={`${t('model.sandbox')}: ${t(SANDBOX_LABEL_KEYS[activeSandbox].full)}`}
            onClick={() => {
              setApprovalOpen(false)
              setSandboxOpen(prev => !prev)
            }}
          >
            <IconShieldOutlineRegular size={14} className={styles.permissionIcon} />
            <span className={styles.permissionLabel}>{sandboxLabel}</span>
            <IconChevronDownOutlineRegular size={12} className={styles.permissionChevron} />
          </button>
        )}
      />

      <Menu
        open={approvalOpen && !busy}
        onClose={() => setApprovalOpen(false)}
        items={[
          { type: 'label', id: 'approval-heading', text: t('model.approval') },
          { id: 'on-request', label: t('approval.onRequest') },
          { id: 'auto-review', label: t('approval.autoReview') },
          { id: 'untrusted', label: t('approval.untrusted') },
          { id: 'never', label: t('approval.never') },
        ]}
        selectedId={activeApproval}
        onSelect={(id) => {
          setApprovalOpen(false)
          if (id === activeApproval) return
          void store.setSessionConfig({
            sessionId,
            approvalPolicy: id as ExternalCliApprovalPolicy,
          }).catch(() => {})
        }}
        align="start"
        side="top"
        portal
        dense
        listClassName={styles.selectMenuList}
        anchor={(
          <button
            type="button"
            className={styles.permissionTrigger}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={approvalOpen && !busy}
            title={`${t('model.approval')}: ${t(APPROVAL_LABEL_KEYS[activeApproval].full)}`}
            onClick={() => {
              setSandboxOpen(false)
              setApprovalOpen(prev => !prev)
            }}
          >
            <IconCheckCircleOutlineRegular size={14} className={styles.permissionIcon} />
            <span className={styles.permissionLabel}>{approvalLabel}</span>
            <IconChevronDownOutlineRegular size={12} className={styles.permissionChevron} />
          </button>
        )}
      />
    </div>
  )
}
