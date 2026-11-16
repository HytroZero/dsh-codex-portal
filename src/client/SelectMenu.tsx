import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import styles from './CodexPortal.module.css'

export interface SelectMenuOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface SelectMenuProps {
  readonly value: string
  readonly options: readonly SelectMenuOption[]
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly align?: 'start' | 'end'
  readonly side?: 'bottom' | 'top'
  readonly onChange: (value: string) => void
}

export function SelectMenu({
  value,
  options,
  placeholder,
  disabled = false,
  align = 'start',
  side = 'bottom',
  onChange,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false)
  const selected = options.find(opt => opt.value === value)
  const displayLabel = selected?.label ?? (value || placeholder || '')
  const isDisabled = disabled || options.length === 0

  return (
    <Menu
      open={open && !isDisabled}
      onClose={() => setOpen(false)}
      items={options.map(opt => ({
        id: opt.value,
        label: opt.label,
        ...(opt.disabled ? { disabled: true } : {}),
      }))}
      selectedId={value}
      onSelect={(id) => {
        setOpen(false)
        if (id !== value) onChange(id)
      }}
      align={align}
      side={side}
      portal
      dense
      minWidthFromAnchor
      className={styles.selectRoot}
      listClassName={styles.selectMenuList}
      anchor={(
        <button
          type="button"
          className={styles.selectTrigger}
          disabled={isDisabled}
          aria-haspopup="menu"
          aria-expanded={open && !isDisabled}
          title={displayLabel}
          onClick={() => setOpen(prev => !prev)}
        >
          <span className={styles.selectValue}>{displayLabel}</span>
          <IconChevronDownOutlineRegular size={12} className={styles.selectChevron} />
        </button>
      )}
    />
  )
}
