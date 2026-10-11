/**
 * A number plate, drawn as a plate.
 *
 * White, a black edge, the blue IND strip, a condensed bold face — so it is
 * recognised as a plate before it is read, on every screen, at every size.
 * The strip appears only on a reading with the Indian shape.
 * The plate is the object this product is about; rendering it as plain mono
 * text made it look like any other identifier in a table.
 *
 * Three states besides the ordinary one, and they are the point:
 *
 *   watched    a red double ring. This vehicle is on the watchlist.
 *   partial    dashed and greyed. The read is incomplete — some characters
 *              were not settled — so it must not look as certain as a full
 *              one.
 *   candidate  an outline only. A plate the system suggests (a near match, a
 *              re-identification) rather than one it read.
 */

import { isIndianPlate, spacedPlate } from '@/lib/plates'

type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const TEXT_SIZE: Record<Size, string> = {
  xs: 'text-[12px]',
  sm: 'text-[14px]',
  md: 'text-[16px]',
  lg: 'text-[22px]',
  xl: 'text-[30px]',
}

export function PlateChip({
  plate,
  size = 'sm',
  watched = false,
  partial = false,
  candidate = false,
  title,
  className = '',
}: {
  plate: string
  size?: Size
  watched?: boolean
  partial?: boolean
  candidate?: boolean
  title?: string
  className?: string
}) {
  const state = [
    watched ? 'is-watched' : '',
    partial ? 'is-partial' : '',
    candidate ? 'is-candidate' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span
      title={title ?? (watched ? `${plate} — on the watchlist` : undefined)}
      className={`plate-chip ${state} ${className}`}
    >
      {/* The IND strip only on a plate that has the Indian shape: a foreign
          or partial reading drawn with it would claim a registration nobody
          read. */}
      {isIndianPlate(plate) && (
        <span className="plate-strip" aria-hidden="true">
          IND
        </span>
      )}
      <span className={`plate-text ${TEXT_SIZE[size]}`}>{spacedPlate(plate)}</span>
    </span>
  )
}
