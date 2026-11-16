import { IconCheckOutlineRegular, IconChevronDownOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './CodexPortal.module.css'
import type { NS } from './locales'
import { SelectMenu } from './SelectMenu'
import type { CodexPortalClientStore, CodexPortalStoreState } from './store'
import { useCodexSessionControl } from './useCodexSession'

export interface CodexModelControlInjected {
  readonly store: CodexPortalClientStore
  readonly t: TranslateNS<typeof NS>
  readonly useCodexPortal?: SnapshotSelectorHook<CodexPortalStoreState>
}

type CodexModelControlProps = PropsRuntime<'conversation.input.right'> & CodexModelControlInjected

export function CodexModelControl({
  store,
  t,
  useCodexPortal,
  useSessions,
  sessionId,
}: CodexModelControlProps) {
  const {
    health,
    models,
    config,
    sessionInfo,
    currentSelection,
    isCodexActive,
  } = useCodexSessionControl({
    store,
    sessionId,
    useSessions,
    useCodexPortal,
  })

  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ left: number; bottom: number }>({ left: 16, bottom: 80 })
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target
      if (target instanceof Node) {
        if (triggerRef.current?.contains(target)) return
        if (popoverRef.current?.contains(target)) return
        if (target instanceof Element && target.closest(`.${styles.selectMenuList}`)) return
      }
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!isCodexActive) return null

  const activeModelId = (currentSelection?.provider === 'codex-portal' ? currentSelection.model : undefined)
    ?? sessionInfo?.model
    ?? config.defaultModel
    ?? models[0]?.id
  const matchedModel = models.find(m => m.id === activeModelId)
  const rawEffort = (currentSelection?.provider === 'codex-portal' ? currentSelection.reasoningEffort : undefined)
    ?? sessionInfo?.reasoningEffort
    ?? config.defaultReasoningEffort
    ?? matchedModel?.defaultReasoningEffort
  const activeEffort = matchedModel?.reasoningEfforts && matchedModel.reasoningEfforts.length > 0
    ? (matchedModel.reasoningEfforts.some(e => e.id === rawEffort)
        ? rawEffort!
        : (matchedModel.defaultReasoningEffort ?? matchedModel.reasoningEfforts[0]!.id))
    : rawEffort

  const displayName = matchedModel?.name ?? (activeModelId === 'codex-default' ? t('model.selectLabel') : activeModelId) ?? t('model.selectLabel')

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setCoords({
        left: Math.max(12, Math.min(rect.right - 280, window.innerWidth - 292)),
        bottom: Math.max(12, window.innerHeight - rect.top + 8),
      })
    }
    setOpen(prev => !prev)
  }

  return (
    <div className={styles.modelSeat} data-codex-model-seat="active">
      <button
        ref={triggerRef}
        type="button"
        className={styles.modelTrigger}
        disabled={sessionInfo?.busy}
        onClick={handleToggle}
        title={`${displayName}${activeEffort ? ` · ${activeEffort}` : ''}`}
      >
        <StateDot state={health?.available && health.authenticated ? 'done' : 'warning'} />
        <span>{displayName}</span>
        {activeEffort && <span className={styles.effortCaption}>· {activeEffort}</span>}
        <IconChevronDownOutlineRegular size={12} />
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className={styles.popover}
          style={{ left: `${coords.left}px`, bottom: `${coords.bottom}px` }}
        >
          <div>
            <div className={styles.popoverSectionTitle}>{t('model.selectLabel')}</div>
            <div className={styles.modelList}>
              {models.length === 0 ? (
                <div className={styles.statusMeta}>
                  {health?.available ? t('model.loading') : t('model.unavailable')}
                </div>
              ) : (
                models.map(model => (
                  <button
                    key={model.id}
                    type="button"
                    className={`${styles.modelOption} ${model.id === matchedModel?.id ? styles.modelOptionActive : ''}`}
                    onClick={() => {
                      void store.selectSessionModel({
                        sessionId,
                        model: model.id,
                        ...(model.defaultReasoningEffort ? { reasoningEffort: model.defaultReasoningEffort } : {}),
                      }).catch(() => {})
                      setOpen(false)
                    }}
                  >
                    <span>{model.name}</span>
                    {model.id === matchedModel?.id && <IconCheckOutlineRegular size={14} />}
                  </button>
                ))
              )}
            </div>
          </div>

          {matchedModel?.reasoningEfforts && matchedModel.reasoningEfforts.length > 0 && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>{t('model.effort')}</label>
              <SelectMenu
                value={activeEffort ?? ''}
                options={matchedModel.reasoningEfforts.map(eff => ({ value: eff.id, label: eff.name }))}
                onChange={(nextEffort) => {
                  if (!matchedModel) return
                  void store.selectSessionModel({
                    sessionId,
                    model: matchedModel.id,
                    reasoningEffort: nextEffort,
                  }).catch(() => {})
                }}
              />
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
