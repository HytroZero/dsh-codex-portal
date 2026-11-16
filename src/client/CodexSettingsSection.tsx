import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import type { ExternalCliApprovalPolicy, ExternalCliSandboxMode } from '../external-cli-contract'
import styles from './CodexPortal.module.css'
import type { NS } from './locales'
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

  const selectedModelInfo = models.find(m => m.id === defaultModel) ?? models[0]
  const efforts = selectedModelInfo?.reasoningEfforts ?? []

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
            <select
              className={styles.select}
              value={defaultModel}
              onChange={(e) => {
                const nextModel = e.target.value
                setDefaultModel(nextModel)
                const found = models.find(m => m.id === nextModel)
                if (found?.defaultReasoningEffort) {
                  setDefaultEffort(found.defaultReasoningEffort)
                }
              }}
            >
              <option value="">{t('settings.modelAuto')}</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('settings.defaultEffort')}</label>
            <select
              className={styles.select}
              value={defaultEffort}
              onChange={e => setDefaultEffort(e.target.value)}
              disabled={efforts.length === 0}
            >
              <option value="">{t('settings.modelAuto')}</option>
              {efforts.map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('settings.defaultSandbox')}</label>
            <select
              className={styles.select}
              value={defaultSandbox}
              onChange={e => setDefaultSandbox(e.target.value as ExternalCliSandboxMode)}
            >
              <option value="read-only">{t('sandbox.readOnly')}</option>
              <option value="workspace-write">{t('sandbox.workspaceWrite')}</option>
              <option value="danger-full-access">{t('sandbox.dangerFullAccess')}</option>
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('settings.defaultApproval')}</label>
            <select
              className={styles.select}
              value={defaultApproval}
              onChange={e => setDefaultApproval(e.target.value as ExternalCliApprovalPolicy)}
            >
              <option value="on-request">{t('approval.onRequest')}</option>
              <option value="untrusted">{t('approval.untrusted')}</option>
              <option value="never">{t('approval.never')}</option>
            </select>
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
