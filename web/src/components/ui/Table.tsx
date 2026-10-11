/** A shared table shell. Watchlist, Users and AuditLog drew a bare `<table>`
 *  with a `border-b` header and no container; Cameras and Fleet Health wrapped
 *  the same idea in a rounded bordered box. Same data-table concept, two
 *  visual languages — this is the one both should render as. */

import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react'

/** `bare` skips the bordered wrapper for a table that already sits inside its
 *  own bordered panel (a section box with its own header row) — otherwise
 *  every table would nest two concentric borders. */
export function Table({
  className = '',
  bare = false,
  ...rest
}: TableHTMLAttributes<HTMLTableElement> & { bare?: boolean }) {
  const table = <table className={`w-full text-[13px] ${className}`} {...rest} />
  if (bare) return table
  return <div className="overflow-x-auto rounded-lg border border-border bg-card">{table}</div>
}

export function Thead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-faint">
      {children}
    </thead>
  )
}

export function Th({ className = '', ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={`px-3 py-2.5 font-medium ${className}`} {...rest} />
}

export function Td({ className = '', ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={`px-3 py-2 ${className}`} {...rest} />
}

export function Tr({ className = '', ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={`border-b border-border/60 transition last:border-0 hover:bg-secondary/40 ${className}`}
      {...rest}
    />
  )
}
