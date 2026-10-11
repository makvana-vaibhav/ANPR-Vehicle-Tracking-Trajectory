/**
 * Live video player.
 *
 * Speaks WHEP (WebRTC-HTTP Egress Protocol) directly against MediaMTX using
 * the browser's own RTCPeerConnection — no player library, no external script,
 * which keeps the offline guarantee intact.
 *
 * WHEP handshake:
 *   1. create a recvonly peer connection
 *   2. POST the SDP offer to the WHEP endpoint as `application/sdp`
 *   3. apply the SDP answer that comes back
 *
 * ICE candidates are gathered fully before the offer is sent (non-trickle).
 * That costs a moment of setup but avoids needing the PATCH endpoint, and on a
 * local gateway gathering completes almost immediately.
 *
 * HLS is the fallback, and it plays **in this element** rather than opening a
 * tab. WebRTC is blocked on plenty of corporate and venue networks, so the
 * fallback has to be a real player, not a link. Safari plays HLS natively;
 * everywhere else hls.js drives Media Source Extensions. It is bundled, not
 * fetched from a CDN, so the offline guarantee holds.
 *
 * ## Why this is more defensive than a player normally needs to be
 *
 * Four things made playback intermittent, and each is handled explicitly here
 * rather than left to chance:
 *
 * **Superseded attempts.** Mounting under React StrictMode runs the effect
 * twice, and switching cameras quickly starts a second attempt while the first
 * is still awaiting an SDP answer. The late one used to win, so the element
 * ended up showing a stream nobody asked for, or none at all. Every attempt
 * now carries a generation, and a stale one abandons itself.
 *
 * **"Connected" is not "playing".** A WebRTC connection reaching `connected`,
 * or an HLS manifest parsing, says the transport works — not that pixels
 * arrived. Both used to be reported as live, which is how a dead camera got
 * labelled LIVE over a black rectangle. Playback is now claimed only once the
 * element has actual video frames.
 *
 * **Negotiation that never finishes.** A peer connection can sit in `checking`
 * indefinitely: no `failed`, no error, no fallback, just a spinner. There is
 * now a deadline, after which HLS is tried.
 *
 * **Stalls after a good start.** A stream that starts and then stops advancing
 * looks identical to a static scene. A watchdog notices the clock has stopped
 * and recovers, rather than leaving a frozen frame labelled live.
 *
 * ## The capture clock
 *
 * Anything drawn over live video needs to know *which* moment the picture is
 * showing, or it can only guess where a vehicle has got to. Both transports can
 * answer, by different means, and `videoClock` gives the overlay one number
 * either way:
 *
 * **HLS** is stamped. MediaMTX writes `EXT-X-PROGRAM-DATE-TIME` into the
 * playlist and hls.js reads it, so the answer is exact. The native HLS players
 * in Safari and Edge expose no such clock, which is why hls.js is preferred
 * over them whenever an overlay is present rather than only when a delay is
 * asked for.
 *
 * **WebRTC** is measured. The connection reports how long it has been holding
 * frames (`jitterBufferDelay` over `jitterBufferEmittedCount`) and the round
 * trip to the gateway, and now minus those is the same quantity the HLS tag
 * gives directly. It used to report "no clock" here, so the overlay fell back
 * to drawing boxes on arrival with no idea how far behind the picture was.
 *
 * `syncDelayMs` is a separate and now largely unnecessary thing: it holds the
 * picture deliberately far behind live so every event arrives before the frame
 * it describes is shown. With the gateway's low-latency HLS the hold-back is
 * already longer than the pipeline, so alignment does not need buying — the
 * delay is worth spending only when the worker is heavily loaded and its
 * capture-to-event latency runs into seconds.
 */

import Hls from 'hls.js'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { Button, Icon, Spinner } from '@/components/ui'

export type PlayerState = 'idle' | 'connecting' | 'playing' | 'failed'
export type Transport = 'webrtc' | 'hls'

/** What the player has settled on, for a caller that labels the picture. */
export interface PlayerStatus {
  state: PlayerState
  transport: Transport
  /** The player can name which capture instant is on screen. */
  clockLive: boolean
}

/** Give up on a peer connection that has not produced video by now. */
const WEBRTC_DEADLINE_MS = 8_000

/** Give up on an HLS ladder that has not produced video by now. */
const HLS_DEADLINE_MS = 15_000

/** Playback that has not advanced for this long is stalled, not quiet. */
const STALL_AFTER_MS = 6_000

/** How long to keep retrying a manifest that is not being published yet. */
const MANIFEST_RETRY_MS = 20_000

/** How often to ask WebRTC how far behind the picture is. */
const RTC_STATS_INTERVAL_MS = 1_000

/**
 * Ignore a WebRTC lag estimate above this, in milliseconds.
 *
 * `jitterBufferDelay` is cumulative over the life of the track, and the first
 * sample after a join includes the decoder settling, so an early reading can
 * be wildly high. A local gateway is tens of milliseconds away; anything past
 * two seconds is a measurement artefact, and reporting no clock is better than
 * reporting a wrong one.
 */
const RTC_MAX_PLAUSIBLE_LAG_MS = 2_000

interface Props {
  whepUrl: string | null
  hlsUrl: string | null
  cameraCode: string
  /** Autoplay on mount. */
  autoStart?: boolean
  /**
   * Start on HLS instead of trying WebRTC first. Federated grids that publish
   * HLS on 443 and WebRTC on a blocked port should set this: attempting WHEP
   * costs a visible failure before the fallback that was always going to win.
   */
  preferHls?: boolean
  /**
   * Hold the picture this far behind the live edge, in milliseconds.
   *
   * Worth doing only on a screen that draws analysis over the video: the delay
   * is what gives the worker time to read a plate and the event time to arrive
   * before the frame it belongs to is shown. HLS only — a WebRTC MediaStream
   * has no seekable buffer to sit inside, so this forces the HLS path when it
   * is set.
   */
  syncDelayMs?: number
  /**
   * Drawn over the video, inside the same box, so an overlay lines up with the
   * picture through fullscreen and resizes alike. Rendered only while the
   * stream is actually playing — boxes over a spinner would be nonsense.
   *
   * Called with a reader for the capture clock of the frame currently on
   * screen, in epoch milliseconds, or null when the transport cannot say.
   */
  overlay?: (videoClock: () => number | null) => ReactNode
  /**
   * The caller's own controls for this picture (what is drawn over it, how
   * far it is held back), set at the start of the player's control row so a
   * stage has one row of controls under the video rather than two.
   */
  toolbar?: ReactNode
  /** Told whenever the state, the transport or the capture clock changes. */
  onStatus?: (status: PlayerStatus) => void
}

/** Wall-clock time in IST, for a capture instant read off the stream. */
function formatCaptureIST(epochMs: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(epochMs))
}

/**
 * Four corners pointing out: full screen.
 *
 * Drawn here because the shared icon set has no such glyph, on the set's own
 * 24-unit grid and 1.5 stroke so it reads as one of them.
 */
function ExpandGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  )
}

/**
 * The capture time of the frame on screen, printed on the picture.
 *
 * Its own component with its own one-second timer, so the tick re-renders a
 * line of text rather than the player and the overlay it hosts. Shows nothing
 * until the transport can say which instant is on screen: a ticking wall clock
 * in the corner of a video reads as "this frame is from now", which is exactly
 * the claim that cannot be made without the capture clock.
 */
function CaptureClock({ videoClock }: { videoClock: () => number | null }) {
  const [shown, setShown] = useState<number | null>(() => videoClock())

  useEffect(() => {
    const timer = window.setInterval(() => setShown(videoClock()), 1_000)
    return () => window.clearInterval(timer)
  }, [videoClock])

  if (shown === null) return null
  return <span title="Capture time of the frame on screen">{formatCaptureIST(shown)} IST</span>
}

/**
 * The platform's reason for refusing a playlist, from a failed HLS request.
 *
 * A 404 is a path nothing is publishing yet, and says nothing worth showing.
 * Anything else the API refuses carries a JSON `detail` — for a grid camera,
 * what the grid itself said, such as `one session per IP` — and that is the
 * sentence an operator needs instead of "nothing is publishing".
 */
export function refusalOf(code: number | undefined, request: unknown): string | null {
  if (!code || code < 400 || code === 404) return null
  const body =
    request instanceof XMLHttpRequest && (request.responseType === '' || request.responseType === 'text')
      ? request.responseText
      : null
  if (!body) return null
  try {
    const detail: unknown = JSON.parse(body)?.detail
    return typeof detail === 'string' && detail.trim() ? detail.trim() : null
  } catch {
    return null
  }
}

/** Wait for ICE gathering, with a ceiling so a stalled gather cannot hang the UI. */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()

  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check)
      window.clearTimeout(timer)
      resolve()
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    // Local candidates are usually enough on a laptop gateway; do not block
    // playback waiting for a gather that may never complete.
    const timer = window.setTimeout(done, timeoutMs)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

export default function StreamPlayer({
  whepUrl,
  hlsUrl,
  cameraCode,
  autoStart = true,
  preferHls = false,
  syncDelayMs = 0,
  overlay,
  toolbar,
  onStatus,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  // Bumped by every teardown. An async attempt that finds the counter has
  // moved on knows it has been superseded and must not touch the element.
  const generationRef = useRef(0)
  const timersRef = useRef<number[]>([])
  const cleanupsRef = useRef<Array<() => void>>([])
  // How far behind the source the WebRTC picture is, in milliseconds, measured
  // from the connection's own statistics. Null until it has been measured, and
  // reset on every teardown so a stale figure never describes a new stream.
  const rtcLagRef = useRef<number | null>(null)

  // Whether anything is drawn over the video, as a *stable* value. `overlay`
  // itself is a fresh closure on every render of the parent, so naming it in a
  // dependency array would tear the stream down and renegotiate it on every
  // event that arrives. This changes only when the caller stops passing one.
  const hasOverlay = overlay !== undefined

  const [state, setState] = useState<PlayerState>('idle')
  const [transport, setTransport] = useState<Transport>(
    preferHls || syncDelayMs > 0 ? 'hls' : 'webrtc',
  )
  const [error, setError] = useState<string | null>(null)
  const [latencyNote, setLatencyNote] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [clockLive, setClockLive] = useState(false)
  // The picture's own size, read off the element once frames arrive — what the
  // camera is actually sending, not what the registry says it should.
  const [resolution, setResolution] = useState<string | null>(null)

  // Held in a ref so a caller passing a fresh closure every render does not
  // re-announce an unchanged status on every render.
  const onStatusRef = useRef(onStatus)
  useEffect(() => {
    onStatusRef.current = onStatus
  }, [onStatus])
  useEffect(() => {
    onStatusRef.current?.({ state, transport, clockLive })
  }, [state, transport, clockLive])

  /**
   * Capture time of the frame on screen, epoch ms, or null.
   *
   * Two transports, two ways of knowing:
   *
   * **HLS** stamps it outright. MediaMTX writes `EXT-X-PROGRAM-DATE-TIME` into
   * the playlist, so hls.js can name the wall-clock moment the displayed frame
   * was captured at. Nothing is estimated.
   *
   * **WebRTC** has no such tag, but it does know how long the picture has been
   * held: `jitterBufferDelay / jitterBufferEmittedCount` is the mean time a
   * frame waited in the receiver, and half the reported round trip covers
   * getting it here. That is a measurement, not a guess, and subtracting it
   * from now gives the same quantity the HLS tag gives directly. Before it has
   * been measured this returns null and the overlay falls back — which is the
   * honest answer rather than a plausible one.
   *
   * Identity-stable: the overlay reads it on every update and would restart
   * its loop on each render if this were a fresh closure each time.
   */
  const videoClock = useCallback((): number | null => {
    const hls = hlsRef.current
    if (hls) {
      const playing = hls.playingDate
      if (playing) return playing.getTime()
      // A live ladder with no programme-date tags can still say how far behind
      // the playlist's live edge it is playing. That is a lower bound on the
      // real distance from capture — the gateway spends time segmenting before
      // anything reaches the edge — so it under-corrects rather than over-, and
      // it is still far better than the alternative of assuming the picture is
      // showing this instant.
      const latency = hls.latency
      return Number.isFinite(latency) && latency > 0 ? Date.now() - latency * 1000 : null
    }
    const lag = rtcLagRef.current
    return lag === null ? null : Date.now() - lag
  }, [])

  /**
   * Sample the peer connection for how far behind the picture is.
   *
   * The jitter-buffer figures are cumulative counters, so the *interval* mean
   * is the difference between two samples rather than the ratio of the latest
   * pair — the lifetime ratio would keep reporting a join's worth of buffering
   * long after it had drained.
   */
  const watchRtcLag = useCallback((pc: RTCPeerConnection, gen: number) => {
    let lastDelay = 0
    let lastCount = 0

    const sample = async () => {
      if (generationRef.current !== gen) return
      let report: RTCStatsReport | null = null
      try {
        report = await pc.getStats()
      } catch {
        return // a closing connection; the generation check catches the rest
      }
      if (report === null || generationRef.current !== gen) return

      // NaN rather than null as the "not reported" value, so every figure here
      // stays a number and one `Number.isFinite` guard covers the lot.
      let rttMs = 0
      let delayS = Number.NaN
      let count = Number.NaN

      report.forEach((raw) => {
        const entry = raw as Record<string, unknown>
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
          const delay = entry.jitterBufferDelay
          const emitted = entry.jitterBufferEmittedCount
          if (typeof delay === 'number') delayS = delay
          if (typeof emitted === 'number') count = emitted
        }
        // The only RTT WebRTC reports for a receive-only stream comes from the
        // candidate pair, and it is a round trip, so half of it is the one-way
        // delay this picture actually paid.
        const rtt = entry.currentRoundTripTime
        if (entry.type === 'candidate-pair' && entry.nominated === true) {
          if (typeof rtt === 'number') rttMs = (rtt * 1000) / 2
        }
      })

      if (!Number.isFinite(delayS) || !Number.isFinite(count)) return
      const frames = count - lastCount
      const buffered = delayS - lastDelay
      lastDelay = delayS
      lastCount = count
      if (frames <= 0) return

      const lag = (buffered / frames) * 1000 + rttMs
      rtcLagRef.current =
        Number.isFinite(lag) && lag >= 0 && lag < RTC_MAX_PLAUSIBLE_LAG_MS ? lag : null
    }

    const timer = window.setInterval(() => void sample(), RTC_STATS_INTERVAL_MS)
    cleanupsRef.current.push(() => window.clearInterval(timer))
    void sample()
  }, [])

  const teardown = useCallback(() => {
    generationRef.current += 1
    for (const timer of timersRef.current) window.clearTimeout(timer)
    timersRef.current = []
    for (const cleanup of cleanupsRef.current) cleanup()
    cleanupsRef.current = []

    pcRef.current?.close()
    pcRef.current = null
    hlsRef.current?.destroy()
    hlsRef.current = null
    rtcLagRef.current = null
    setClockLive(false)
    setResolution(null)
    if (videoRef.current) {
      videoRef.current.srcObject = null
      videoRef.current.removeAttribute('src')
      videoRef.current.load()
    }
  }, [])

  const after = useCallback((ms: number, fn: () => void) => {
    timersRef.current.push(window.setTimeout(fn, ms))
  }, [])

  /**
   * Resolve once the element is genuinely rendering video.
   *
   * `playing` alone fires for audio-only and for a decoder that has committed
   * to nothing; `videoWidth` is what proves a picture exists.
   */
  const onFirstFrame = useCallback(
    (video: HTMLVideoElement, gen: number, then: () => void) => {
      const check = () => {
        if (generationRef.current !== gen) return
        if (video.videoWidth > 0 && video.readyState >= 2) {
          detach()
          setResolution(`${video.videoWidth}×${video.videoHeight}`)
          then()
        }
      }
      const detach = () => {
        video.removeEventListener('playing', check)
        video.removeEventListener('loadeddata', check)
        video.removeEventListener('resize', check)
      }
      video.addEventListener('playing', check)
      video.addEventListener('loadeddata', check)
      video.addEventListener('resize', check)
      cleanupsRef.current.push(detach)
      check()
    },
    [],
  )

  // Recovery paths need to call back into the current playHls, but playHls is
  // defined below and rebuilds whenever the URLs change. The ref breaks that
  // cycle without capturing a stale closure.
  const playHlsRef = useRef<(() => void) | null>(null)

  /**
   * Notice a stream that started and then stopped.
   *
   * A frozen picture is indistinguishable from a quiet junction, so the only
   * reliable signal is the media clock: if `currentTime` has not moved, no
   * frames are being presented whatever the transport claims.
   */
  const watchForStalls = useCallback(
    (video: HTMLVideoElement, gen: number, recover: () => void) => {
      let lastTime = video.currentTime
      let lastProgress = performance.now()
      const timer = window.setInterval(() => {
        if (generationRef.current !== gen) {
          window.clearInterval(timer)
          return
        }
        if (video.currentTime !== lastTime) {
          lastTime = video.currentTime
          lastProgress = performance.now()
          return
        }
        if (video.paused) return
        if (performance.now() - lastProgress > STALL_AFTER_MS) {
          window.clearInterval(timer)
          recover()
        }
      }, 1_000)
      cleanupsRef.current.push(() => window.clearInterval(timer))
    },
    [],
  )

  /** Play the HLS ladder in this element. */
  const playHls = useCallback(() => {
    const video = videoRef.current
    const source = hlsUrl
    if (!video || !source) {
      setError('No HLS endpoint for this camera')
      setState('failed')
      return
    }

    teardown()
    const gen = generationRef.current
    setTransport('hls')
    setState('connecting')
    setError(null)
    const started = performance.now()
    const syncSeconds = syncDelayMs / 1000

    // Safari, iOS and Edge play HLS natively, and left to themselves that is
    // the better path: hardware decoding, no JavaScript in the loop. But the
    // native player exposes no programme-date clock, and the clock is what lets
    // an overlay put a box on the frame it was measured in — so whenever
    // something is being drawn over this video and hls.js can run, hls.js
    // runs. Measured in Edge: the native path played fine and the badge never
    // said "synced", because there was nothing to sync to.
    //
    // This is gated on `overlay`, not on `syncDelayMs`, and the difference
    // matters. With the native player and no clock the overlay has to schedule
    // boxes from their arrival and guess how far behind the picture is, and on
    // HLS that guess is wrong by seconds — which is precisely how a prompt
    // reading ends up drawn over the wrong car.
    const wantsClock = (syncSeconds > 0 || hasOverlay) && Hls.isSupported()
    if (!wantsClock && video.canPlayType('application/vnd.apple.mpegurl')) {
      const onError = () => {
        if (generationRef.current !== gen) return
        setState('failed')
        setError(
          video.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? 'No video is being published for this camera'
            : `Playback error (${video.error?.message || 'unknown'})`,
        )
      }
      video.addEventListener('error', onError)
      cleanupsRef.current.push(() => video.removeEventListener('error', onError))

      after(HLS_DEADLINE_MS, () => {
        if (generationRef.current !== gen || video.videoWidth > 0) return
        setState('failed')
        setError('No video arrived within 15 seconds — nothing is publishing this camera')
      })

      // Wait for actual video before claiming to be live. Setting src and
      // reporting success immediately is how a dead camera ends up labelled
      // "LIVE" over a black rectangle — the worst kind of wrong, because it
      // tells an operator a feed is healthy when nothing is arriving.
      onFirstFrame(video, gen, () => {
        setState('playing')
        setLatencyNote(`HLS (native) in ${Math.round(performance.now() - started)} ms`)
        watchForStalls(video, gen, () => playHlsRef.current?.())
      })

      video.src = source
      video.play().catch(() => undefined)
      return
    }

    if (!Hls.isSupported()) {
      setState('failed')
      setError('This browser cannot play HLS')
      return
    }

    const hls = new Hls(
      syncSeconds > 0
        ? {
            // Deliberately *not* low-latency mode. This screen is trading
            // latency for alignment: the picture sits a fixed distance behind
            // live so that a plate read on a frame arrives before that frame is
            // shown. Chasing the live edge would defeat exactly that.
            lowLatencyMode: false,
            liveSyncDuration: syncSeconds,
            liveMaxLatencyDuration: syncSeconds + 6,
            // Catch up gently after a stall rather than jumping, which on a
            // synced overlay would slide every box at once.
            maxLiveSyncPlaybackRate: 1.2,
            backBufferLength: 30,
            manifestLoadingMaxRetry: 6,
            fragLoadingMaxRetry: 6,
          }
        : {
            // A live wall wants the newest picture, not a smooth buffered one.
            //
            // Deliberately **no** `liveSyncDuration*` here. The gateway is
            // configured for low-latency HLS — 1 s segments cut into 200 ms
            // parts — and publishes a `PART-HOLD-BACK` of about 600 ms, which
            // is hls.js's target distance from the live edge when it is left
            // to read it. Setting `liveSyncDurationCount: 2` overrode that
            // with two *target durations*, so the player sat a full two
            // seconds behind live for no reason anybody had asked for. On a
            // screen that draws plate boxes over the picture, that delay is
            // indistinguishable from the AI being slow: the reading is
            // already in the browser while the frame it describes is still
            // two seconds from being shown.
            lowLatencyMode: true,
            backBufferLength: 10,
            manifestLoadingMaxRetry: 6,
            fragLoadingMaxRetry: 6,
          },
    )
    hlsRef.current = hls
    // What the platform said when it last refused the playlist. A camera
    // nobody is publishing and a grid refusing our session both end with no
    // video, but only one of them is "nothing is publishing" — and saying
    // that about the other sends an operator looking at the camera when the
    // fix is a session (the grid allows one per IP).
    let refusal: string | null = null

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (generationRef.current !== gen) return
      video.play().catch(() => undefined)
    })

    // A parsed manifest is not a picture. Report live only once frames are
    // actually rendering, for the same reason as the native path above.
    onFirstFrame(video, gen, () => {
      setState('playing')
      setLatencyNote(
        syncSeconds > 0
          ? `HLS, held ${syncSeconds.toFixed(1)}s behind live so boxes line up`
          : `HLS in ${Math.round(performance.now() - started)} ms`,
      )
      // Sampled on a timer rather than once here: the programme-date tags are
      // parsed from the playlist, which has usually not happened by the time
      // the first frame renders. Reading it once would leave the badge saying
      // "not synced" on a stream that is in fact synced.
      const clockProbe = window.setInterval(() => {
        if (generationRef.current !== gen) {
          window.clearInterval(clockProbe)
          return
        }
        // Asked through `videoClock` rather than by reading `playingDate`
        // directly, so the badge tells the truth on a ladder that is aligned
        // through the latency fallback instead of a programme-date tag.
        setClockLive(videoClock() !== null)
      }, 1_000)
      cleanupsRef.current.push(() => window.clearInterval(clockProbe))

      watchForStalls(video, gen, () => {
        // A live ladder that stopped advancing usually just needs to be told
        // to load again from the current edge.
        hls.startLoad()
        after(STALL_AFTER_MS, () => {
          if (generationRef.current !== gen) return
          if (video.currentTime > 0 && !video.paused) return
          playHlsRef.current?.()
        })
      })
    })

    after(HLS_DEADLINE_MS, () => {
      if (generationRef.current !== gen || video.videoWidth > 0) return
      // A fatal error has already explained itself and destroyed the player;
      // the deadline must not overwrite a codec message with a vaguer one.
      if (hlsRef.current !== hls) return
      setState('failed')
      setError(
        refusal ?? 'No video arrived within 15 seconds — nothing is publishing this camera',
      )
    })

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (generationRef.current !== gen) return
      const said = refusalOf(data.response?.code, data.networkDetails)
      if (said) refusal = said
      if (!data.fatal) return

      // A path that is not being published yet answers 404. That is a normal
      // state on a gateway whose publisher is still starting, not a failure,
      // so the manifest is retried for a while before giving up.
      const manifestMissing =
        data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
        data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
      if (manifestMissing && performance.now() - started < MANIFEST_RETRY_MS) {
        after(1_000, () => {
          if (generationRef.current !== gen) return
          hls.loadSource(source)
        })
        return
      }

      // Network and media errors are usually recoverable, and a live feed that
      // gives up on the first bad segment is useless — decoder complaints at
      // join are normal and self-correct.
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad()
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError()
      } else {
        hls.destroy()
        hlsRef.current = null
        setState('failed')
        // H.265/HEVC is common on newer Indian CCTV and is not decodable by
        // Media Source Extensions in Chrome or Firefox — Safari can. Saying so
        // is far more useful than "playback failed", because the fix is to open
        // it in Safari, not to retry.
        if (data.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR) {
          setError(
            'This camera streams H.265/HEVC, which this browser cannot decode. ' +
              'Safari plays it; Chrome and Firefox do not.',
          )
        } else {
          setError(`HLS failed: ${data.details}`)
        }
      }
    })

    hls.loadSource(source)
    hls.attachMedia(video)
  }, [
    hlsUrl,
    syncDelayMs,
    hasOverlay,
    teardown,
    after,
    onFirstFrame,
    watchForStalls,
    videoClock,
  ])

  // Assigned in an effect rather than during render: effects run before any
  // timer or media callback can fire, so the ref is always current by the time
  // a recovery path reads it, and render stays free of side effects.
  useEffect(() => {
    playHlsRef.current = playHls
  }, [playHls])

  const connect = useCallback(async () => {
    // Alignment needs a buffer to sit inside, which a MediaStream does not
    // have. Asking for a synced overlay is therefore asking for HLS.
    if (syncDelayMs > 0 && hlsUrl) {
      playHls()
      return
    }
    if (!whepUrl) {
      // Nothing to negotiate — go straight to the transport that exists.
      if (hlsUrl) {
        playHls()
        return
      }
      setError('No WebRTC or HLS endpoint for this camera')
      setState('failed')
      return
    }

    teardown()
    const gen = generationRef.current
    const video = videoRef.current
    setTransport('webrtc')
    setState('connecting')
    setError(null)

    const started = performance.now()
    // No STUN/TURN: the gateway is on the same host, and reaching out to a
    // public STUN server would break the zero-external-dependency guarantee.
    const pc = new RTCPeerConnection({ iceServers: [] })
    pcRef.current = pc

    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })

    pc.ontrack = (event) => {
      if (generationRef.current !== gen) return
      const [stream] = event.streams
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream
        videoRef.current.play().catch(() => undefined)
      }
    }

    const fallback = (why: string) => {
      if (generationRef.current !== gen) return
      if (hlsUrl) {
        playHls()
        setLatencyNote(`WebRTC unavailable (${why}) — using HLS`)
      } else {
        setState('failed')
        setError(`WebRTC failed (${why}) and this camera has no HLS endpoint`)
      }
    }

    pc.onconnectionstatechange = () => {
      if (generationRef.current !== gen) return
      // `connected` is deliberately not treated as success; see onFirstFrame.
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        fallback(pc.connectionState)
      }
    }

    if (video) {
      onFirstFrame(video, gen, () => {
        setState('playing')
        setLatencyNote(`WebRTC in ${Math.round(performance.now() - started)} ms`)
        // WebRTC carries no programme-date tag, but it can be *asked* how long
        // it has been holding frames, which answers the same question. Until
        // the first sample lands there is no clock and the overlay is told so.
        setClockLive(false)
        watchRtcLag(pc, gen)
        const clockProbe = window.setInterval(() => {
          if (generationRef.current !== gen) {
            window.clearInterval(clockProbe)
            return
          }
          setClockLive(rtcLagRef.current !== null)
        }, RTC_STATS_INTERVAL_MS)
        cleanupsRef.current.push(() => window.clearInterval(clockProbe))
        watchForStalls(video, gen, () => fallback('stream stalled'))
      })
    }

    // A peer connection can sit in `checking` forever: no error, no failure
    // event, just a spinner. Give it a deadline and move on.
    after(WEBRTC_DEADLINE_MS, () => {
      if (generationRef.current !== gen) return
      if (video && video.videoWidth > 0) return
      fallback('no video within 8s')
    })

    try {
      const offer = await pc.createOffer()
      if (generationRef.current !== gen) return
      await pc.setLocalDescription(offer)
      await waitForIceGathering(pc)
      if (generationRef.current !== gen) return

      const response = await fetch(whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription?.sdp ?? offer.sdp ?? '',
      })
      if (generationRef.current !== gen) return

      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? 'no stream is being published for this camera'
            : `gateway refused the stream (HTTP ${response.status})`,
        )
      }

      const answer = await response.text()
      if (generationRef.current !== gen) return
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    } catch (err) {
      // The common case on a restricted network: WHEP is unreachable and HLS
      // over 443 is not. Switch rather than report a failure the operator
      // cannot act on.
      fallback(err instanceof Error ? err.message : String(err))
    }
  }, [
    whepUrl,
    hlsUrl,
    syncDelayMs,
    playHls,
    teardown,
    after,
    onFirstFrame,
    watchForStalls,
    watchRtcLag,
  ])

  useEffect(() => {
    if (!autoStart) return teardown
    if ((preferHls || syncDelayMs > 0) && hlsUrl) {
      playHls()
    } else if (whepUrl || hlsUrl) {
      void connect()
    }
    return teardown
  }, [
    autoStart,
    preferHls,
    syncDelayMs,
    hlsUrl,
    whepUrl,
    connect,
    playHls,
    teardown,
  ])

  // Track fullscreen from the document, so the Escape key and the browser's own
  // controls keep the button label honest.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === shellRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // An adaptive ladder can change size mid-stream; the label follows it.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onResize = () => {
      if (video.videoWidth > 0) setResolution(`${video.videoWidth}×${video.videoHeight}`)
    }
    video.addEventListener('resize', onResize)
    return () => video.removeEventListener('resize', onResize)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current
    if (!shell) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void shell.requestFullscreen?.().catch(() => undefined)
    }
  }, [])

  const transportLabel = transport === 'hls' ? 'HLS' : 'WebRTC'

  return (
    <div className="space-y-2">
      <div
        ref={shellRef}
        className="group relative aspect-video overflow-hidden rounded-lg border border-border bg-background"
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-contain"
        />

        {state === 'connecting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-background/75">
            <Spinner className="h-6 w-6" />
            <p className="text-xs text-muted-foreground">
              {transport === 'hls' ? 'Buffering HLS…' : 'Negotiating WebRTC…'}
            </p>
          </div>
        )}

        {/* Amber, not red: a feed that will not play needs looking at, but it
            is equipment, not an emergency — red on this screen is kept for a
            watched vehicle. The reason is the sentence the transport or the
            grid gave, and the retry is where the eye already is. */}
        {state === 'failed' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/85 px-6 text-center">
            <Icon name="video" size={22} className="text-status-degraded" />
            <p className="text-[13px] font-medium text-status-degraded">
              Cannot play this stream
            </p>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" className="mt-1" onClick={() => void connect()}>
              <Icon name="refresh" size={13} />
              Retry
            </Button>
          </div>
        )}

        {state === 'playing' && overlay?.(videoClock)}

        {state === 'playing' && (
          <span className="absolute left-2.5 top-2.5 flex h-6 items-center gap-1.5 rounded-md border border-border bg-background/80 px-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground">
            <span className="h-1.5 w-1.5 animate-pulse-alert rounded-full bg-status-online" />
            Live · {transportLabel}
            {/* Not "synced", which used to mean "the picture is being held
                back". This says the narrower and more useful thing: the player
                can name which capture instant is on screen, so an overlay can
                place a box on the frame it was measured in. True of HLS from
                its programme-date tags and of WebRTC once its receive lag has
                been measured — with or without a deliberate delay. */}
            {clockLive && <span className="text-primary">· aligned</span>}
          </span>
        )}

        {/* The code stays on the picture itself, because full screen takes
            the page's own title bar away with it. */}
        <span className="absolute right-2.5 top-2.5 flex h-6 items-center rounded-md border border-border bg-background/80 px-2 font-mono text-[11px] text-foreground">
          {cameraCode}
        </span>

        {state === 'playing' && (
          <span className="pointer-events-none absolute bottom-2.5 left-2.5 flex items-center gap-2 rounded-md bg-background/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            <CaptureClock videoClock={videoClock} />
            <span>
              {transportLabel}
              {resolution && ` · ${resolution}`}
            </span>
          </span>
        )}

        {/* Expand sits on the video itself, where a viewer expects it. */}
        <button
          type="button"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit full screen' : 'Full screen'}
          aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          className="absolute bottom-2.5 right-2.5 flex h-7 items-center gap-1.5 rounded-md border border-border bg-background/80 px-2 text-xs text-muted-foreground opacity-0 transition hover:text-foreground focus:opacity-100 group-hover:opacity-100"
        >
          <ExpandGlyph />
          {isFullscreen ? 'Exit' : 'Full screen'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {toolbar}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {latencyNote && (
            <span className="mr-1 font-mono text-[11px] text-faint">{latencyNote}</span>
          )}
          {/* A failed stream offers its retry on the picture, beside the
              reason; offering it twice would be two buttons for one act. */}
          {state !== 'playing' && state !== 'failed' && (
            <Button variant="outline" size="sm" onClick={() => void connect()}>
              <Icon name="play" size={12} />
              Play
            </Button>
          )}
          {hlsUrl && transport !== 'hls' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={playHls}
              title="Higher latency, but traverses networks that block WebRTC"
            >
              Switch to HLS
            </Button>
          )}
          {whepUrl && transport === 'hls' && syncDelayMs === 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void connect()}
              title="Lower latency where the network allows it"
            >
              Try WebRTC
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={toggleFullscreen}>
            <ExpandGlyph />
            Full screen
          </Button>
        </div>
      </div>
    </div>
  )
}
