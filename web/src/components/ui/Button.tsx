/** Every clickable action, one component. `primary` is the one commitful
 *  action a form should have; `outline` and `ghost` are for anything beside
 *  it; `destructive` is reserved for actions an operator cannot easily walk
 *  back (remove a camera, deactivate an account). Mixing raw
 *  `bg-primary`/`border-border` buttons per file is exactly how a product
 *  ends up with four slightly different button paddings.
 *
 *  Primary is near-white, not the accent. The accent is the trail — what is
 *  selected, linked or being read — and a button painted in it would read as
 *  one more thing on screen that is "live". */

import { forwardRef, type ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'outline' | 'ghost' | 'destructive'
type Size = 'sm' | 'md'

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'bg-foreground text-background hover:bg-foreground/90',
  outline:
    'border border-input bg-transparent text-foreground hover:border-muted-foreground/60 hover:bg-secondary/60',
  ghost: 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
  destructive:
    'border border-status-offline/50 text-status-offline hover:bg-status-offline/10',
}

const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3.5 text-[13px]',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(({ variant = 'primary', size = 'md', className = '', type = 'button', ...rest }, ref) => (
  <button
    ref={ref}
    type={type}
    className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
    {...rest}
  />
))
Button.displayName = 'Button'
