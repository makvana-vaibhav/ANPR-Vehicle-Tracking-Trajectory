/** What a map's box shows when the browser cannot draw a map. See lib/maps. */

import { Icon } from '@/components/ui'

export default function MapUnavailable({ className = '' }: { className?: string }) {
  return (
    <div
      role="status"
      className={`absolute inset-0 grid place-items-center bg-background px-6 text-center ${className}`}
    >
      <div className="max-w-sm">
        <span className="mx-auto mb-3 grid h-9 w-9 place-items-center rounded-full border border-border text-faint">
          <Icon name="map" size={17} />
        </span>
        <p className="text-[13px] font-medium">This browser could not draw the map</p>
        <p className="mt-1 text-xs leading-relaxed text-faint">
          Maps need WebGL, and the browser refused it — graphics acceleration may be switched
          off. Everything else on this screen still works. Turning acceleration on, or using
          another browser, brings the map back.
        </p>
      </div>
    </div>
  )
}
