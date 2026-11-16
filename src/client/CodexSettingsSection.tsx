import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import type { ExternalCliApprovalPolicy, ExternalCliSandboxMode } from '../external-cli-contract'
import styles from './CodexPortal.module.css'
import type { NS } from './locales'
import { SelectMenu } from './SelectMenu'
import { useCodexPortalSelector, type CodexPortalClientStore, type CodexPortalStoreState } from './store'

export interface CodexSettingsInjected {
  readonly store: CodexPortalClientStore
  readonly t: TranslateNS<typeof NS>
  readonly useCodexPortal?: SnapshotSelectorHook<CodexPortalStoreState>
}

type CodexSettingsProps = PropsRuntime<'settings.section'> & CodexSettingsInjected

export function CodexSettingsSection({ store, t, useCodexPortal }: CodexSettingsProps) {
  const health = useCodexPortalSelector(store, s => s.health, undefined, useCodexPortal)
  const models = useCodexPortalSelector(store, s => s.models, undefined, useCodexPortal)
  const config = useCodexPortalSelector(store, s => s.config, undefined, useCodexPortal)
  const checking = useCodexPortalSelector(store, s => s.checking, undefined, useCodexPortal)
  const saving = useCodexPortalSelector(store, s => s.saving, undefined, useCodexPortal)
  const error = useCodexPortalSelector(store, s => s.error, undefined, useCodexPortal)

  const [binaryPath, setBinaryPath] = useState(config.binaryPath ?? '')
  const [defaultModel, setDefaultModel] = useState(config.defaultModel ?? '')
  const [defaultEffort, setDefaultEffort] = useState(config.defaultReasoningEffort ?? '')
  const [defaultSandbox, setDefaultSandbox] = useState<ExternalCliSandboxMode>(config.defaultSandboxMode)
  const [defaultApproval, setDefaultApproval] = useState<ExternalCliApprovalPolicy>(config.defaultApprovalPolicy)

  useEffect(() => {
    setBinaryPath(config.binaryPath ?? '')
    setDefaultModel(config.defaultModel ?? '')
    setDefaultEffort(config.defaultReasoningEffort ?? '')
    setDefaultSandbox(config.defaultSandboxMode)
    setDefaultApproval(config.defaultApprovalPolicy)
  }, [config])

  const selectedModelInfo = (defaultModel ? models.find(m => m.id === defaultModel) : undefined) ?? models[0]
  const efforts = selectedModelInfo?.reasoningEfforts ?? []

  const modelOptions = [
    { value: '', label: t('settings.modelAuto') },
    ...models.map(m => ({ value: m.id, label: m.name })),
    ...(defaultModel && !models.some(m => m.id === defaultModel)
      ? [{ value: defaultModel, label: defaultModel }]
      : []),
  ]

  const effortOptions = [
    { value: '', label: t('settings.modelAuto') },
    ...efforts.map(e => ({ value: e.id, label: e.name })),
    ...(defaultEffort && !efforts.some(e => e.id === defaultEffort)
      ? [{ value: defaultEffort, label: defaultEffort }]
      : []),
  ]

  const sandboxOptions = [
    { value: 'read-only', label: t('sandbox.readOnly') },
    { value: 'workspace-write', label: t('sandbox.workspaceWrite') },
    { value: 'danger-full-access', label: t('sandbox.dangerFullAccess') },
  ]

  const approvalOptions = [
    { value: 'on-request', label: t('approval.onRequest') },
    { value: 'auto-review', label: t('approval.autoReview') },
    { value: 'untrusted', label: t('approval.untrusted') },
    { value: 'never', label: t('approval.never') },
  ]

  const statusTone = !health
    ? 'info'
    : health.available && health.authenticated
      ? 'success'
      : 'warning'
  const statusDot = !health
    ? 'ongoing'
    : health.available && health.authenticated
      ? 'done'
      : 'warning'
  const statusLabel = !health
    ? t('settings.status.checking')
    : !health.available
      ? t('settings.status.notFound')
      : !health.authenticated
        ? t('settings.status.notAuth')
        : t('settings.status.ready')

  async function handleSave() {
    await store.setConfig({
      binaryPath: binaryPath.trim(),
      defaultModel: defaultModel.trim(),
      defaultReasoningEffort: defaultEffort.trim(),
      defaultSandboxMode: defaultSandbox,
      defaultApprovalPolicy: defaultApproval,
    }).catch(() => {})
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <h3 className={styles.title}>{t('settings.title')}</h3>
        <p className={styles.subtitle}>{t('settings.subtitle')}</p>
      </div>

      <div className={styles.card}>
        <div className={styles.statusRow}>
          <div className={styles.statusTitle}>
            <StateDot state={statusDot} />
            <span>{statusLabel}</span>
            {health?.version && <Tag tone={statusTone}>{health.version}</Tag>}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={() => void store.checkHealth().catch(() => {})}
          >
            {t('settings.recheck')}
          </Button>
        </div>

        {health?.binaryPath && (
          <div className={styles.statusMeta}>{health.binaryPath}</div>
        )}
        {health?.accountLabel && (
          <div className={styles.statusMeta}>{health.accountLabel}</div>
        )}
        {health && !health.available && (
          <div className={styles.hint}>{health.message ?? t('settings.installHint')}</div>
        )}
        {health && health.available && !health.authenticated && (
          <div className={styles.hint}>{health.message ?? t('settings.loginHint')}</div>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>{t('settings.binaryPath')}</label>
          <input
            className={styles.input}
            type="text"
            value={binaryPath}
            placeholder={t('settings.binaryPlaceholder')}
            onChange={e => setBinaryPath(e.target.value)}
          />
        </div>

        <div className={styles.statusTitle}>{t('settings.defaultsTitle')}</div>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('settings.defaultModel')}</label>
            <SelectMenu
              value={defaultModel}
              options={modelOptions}
              onChange={(nextModel) => {
                setDefaultModel(nextModel)
                const found = nextModel ? models.find(m => m.id === nextModel) : models[0]
                if (found?.defaultReasoningEffort) {
                  setDefaultEffort(found.defaultReasoningEffort)
                } else if (defaultEffort && !found?.reasoningEfforts?.some(e => e.id === defaultEffort)) {
                  setDefaultEffort('')
                }
              }}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('settings.defaultEffort')}</label>
            <SelectMenu
              value={defaultEffort}
              options={effortOptions}
              disabled={efforts.length === 0}
              onChange={setDefaultEffort}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('settings.defaultSandbox')}</label>
            <SelectMenu
              value={defaultSandbox}
              options={sandboxOptions}
              onChange={val => setDefaultSandbox(val as ExternalCliSandboxMode)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('settings.defaultApproval')}</label>
            <SelectMenu
              value={defaultApproval}
              options={approvalOptions}
              onChange={val => setDefaultApproval(val as ExternalCliApprovalPolicy)}
            />
          </div>
        </div>

        {error && <div className={styles.errorBox}>{error}</div>}

        <div className={styles.actions}>
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
            {saving ? t('settings.saving') : t('settings.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
