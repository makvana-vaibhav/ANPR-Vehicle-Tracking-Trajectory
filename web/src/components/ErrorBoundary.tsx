/**
 * One screen's failure stays on that screen.
 *
 * Without a boundary, an exception anywhere in a page unmounts the whole
 * application: the top bar, the alarm count and the way to any other screen
 * go with it, and an operator is left with a blank window mid-shift. This
 * keeps the shell standing, says what failed, and offers the two ways out — try
 * again, or go to Command. The shell keys it on the address, so moving to
 * another screen clears it.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button, Icon } from '@/components/ui'

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Screen failed', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div role="alert" className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="max-w-md rounded-lg border border-border bg-card px-6 py-6">
          <span className="mb-3 grid h-9 w-9 place-items-center rounded-full border border-priority-high/50 text-priority-high">
            <Icon name="alert" size={17} />
          </span>
          <p className="text-[15px] font-semibold">This screen stopped working</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Nothing was lost, and the rest of Contrail is unaffected. Try the screen again, or go
            to the Overview and come back.
          </p>
          <p className="mt-3 break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] text-faint">
            {error.message.slice(0, 300)}
          </p>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.location.assign('/dashboard')}>
              Go to Overview
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
