/**
 * Transient notices.
 *
 * Inline red text under a form is easy to miss and easy to leave behind: it
 * stays on screen after the thing it described stopped being true, and on a
 * long page it can be scrolled out of view entirely while the operator waits
 * for something that already failed.
 *
 * Errors are **not** auto-dismissed. A success can vanish — the outcome is
 * visible in the thing that changed — but a failure the operator did not read
 * is a failure they will assume did not happen.
 *
 * Drawn in the product's language: a raised surface, never a filled colour
 * block. A failure carries the severity triangle, the word and the red — the
 * same three channels a critical alarm uses, so it reads as one before it is
 * read at all. A success or a note carries the trail accent on its icon only:
 * it is information, and nothing on it needs a person.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { Icon, SeverityGlyph } from '@/components/ui'

export type ToastKind = 'success' | 'error' | 'info'

interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  success: (message: string) => void
  error: (message: unknown) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** Success and info clear themselves; errors wait to be dismissed. */
const DISMISS_AFTER_MS = 5_000

/** Past this many notices on screen, offer to clear them in one go — a run of
 *  failures should not have to be closed one × at a time. */
const CLEAR_ALL_FROM = 3

const BORDER: Record<ToastKind, string> = {
  success: 'border-border',
  error: 'border-priority-critical/45',
  info: 'border-border',
}

function Glyph({ kind }: { kind: ToastKind }) {
  if (kind === 'error') {
    return <SeverityGlyph priority="critical" size={11} className="text-priority-critical" />
  }
  return <Icon name={kind === 'success' ? 'check' : 'info'} size={15} className="text-primary" />
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = Date.now() + Math.random()
      setToasts((current) => [...current, { id, kind, message }])
      if (kind !== 'error') {
        window.setTimeout(() => dismiss(id), DISMISS_AFTER_MS)
      }
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      info: (message) => push('info', message),
      // Accepts an unknown so every catch block can hand it whatever it caught
      // rather than each one re-deriving the same message.
      error: (thrown) =>
        push('error', thrown instanceof Error ? thrown.message : String(thrown)),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // Announced to screen readers: an operator who cannot see the corner
        // of the screen still needs to know the action failed. A failure also
        // carries role="alert" itself, so it interrupts rather than queues.
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col items-stretch gap-2 print:hidden"
      >
        {toasts.length >= CLEAR_ALL_FROM && (
          <button
            type="button"
            onClick={() => setToasts([])}
            className="pointer-events-auto self-end rounded-md border border-border bg-popover px-2.5 py-1 text-xs text-muted-foreground shadow-lg transition hover:text-foreground"
          >
            Clear all {toasts.length}
          </button>
        )}
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : undefined}
            className={`pointer-events-auto flex animate-ticker-in items-start gap-2.5 rounded-lg border bg-popover py-2.5 pl-3 pr-1.5 shadow-2xl ${BORDER[toast.kind]}`}
          >
            <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center">
              <Glyph kind={toast.kind} />
            </span>
            <div className="min-w-0 flex-1">
              {toast.kind === 'error' && (
                <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-priority-critical">
                  Failed
                </p>
              )}
              <p className="break-words text-[13px] leading-relaxed text-foreground">
                {toast.message}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside a ToastProvider')
  return context
}
