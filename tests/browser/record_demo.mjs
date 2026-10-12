// Record the live-test walk-through as a video, on the running stack.
//
//   node record_demo.mjs [--base http://localhost:8080] [--out ../../docs/submission/video]
//                        [--plate GJ16DP1240] [--headed] [--no-mp4]
//
// Signs in through the real form with the bootstrap admin from .env (never
// printed), then walks the Sentinel live test with a one-line caption on screen
// for each step: Command → ⌘K a plate → Investigate (route, registry card,
// pursuit prediction without starting it, candidates, CSV) → Live CAM-DEMO-01 →
// watch a plate the recorded clip is reading and wait for the alarm the
// pipeline raises by itself → the alarm's detail → Persons and a face match
// with its human-confirmation notice → Network map → Insights → Audit.
//
// What it creates it removes: the watchlist entry is retired and its alarm is
// closed with a note saying it was a recording, whether or not a step failed.
// It never starts a pursuit (so it never pins a camera) and never opens a grid
// camera: every request to the grid's hosts is refused, and Live is only ever
// opened on CAM-DEMO-01.
//
// Output: <out>/contrail-demo-<IST timestamp>.webm, and .mp4 when ffmpeg is on
// PATH. The duration is printed at the end.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'

import { api, guardGrid, launch, login } from './session.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const BASE = opt('base', 'http://localhost:8080')
const OUT = opt('out', new URL('../../docs/submission/video', import.meta.url).pathname)
const WORK = new URL('./out/video/', import.meta.url).pathname
const W = 1600
const H = 900
const DEMO_CAMERA = 'CAM-DEMO-01'
const CASE_REF = 'DEMO/VIDEO/2026'
/** The API answers some lists as an array and some as a page of items. */
const rows = (body) => (Array.isArray(body) ? body : (body?.items ?? []))

mkdirSync(OUT, { recursive: true })
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

const { token, username, password } = await login()
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m)

// ── What to show, chosen from the live data ─────────────────────────────────

const cameras = (await api('/cameras?limit=100', token)).body.items ?? []
const demoCamera = cameras.find((c) => c.camera_code === DEMO_CAMERA)
if (!demoCamera) throw new Error(`${DEMO_CAMERA} is not in the registry`)

/** A camera whose position is known: a route and a pursuit prediction need one. */
const placed = (c) =>
  c.lat != null && c.lon != null && !(c.tags ?? []).some((t) => /^placement:(none|unplaced|unknown)|^unplaced/.test(t))

/**
 * A Gujarat plate the organisers' grid cameras read, for the ⌘K step: read
 * at a camera with a known position if any is, so the map has a point and
 * the pursuit panel has somewhere to predict from.
 */
async function gridPlate() {
  const asked = opt('plate', null)
  if (asked) return asked.toUpperCase()
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const grid = cameras.filter((x) => x.camera_code.startsWith('SBX-'))
  const withPosition = grid.filter(placed)
  for (const pool of [withPosition, grid]) {
    const plate = await bestPlate(pool, since)
    if (plate) return plate
  }
  return null
}

async function bestPlate(pool, since) {
  const reads = []
  for (const c of pool) {
    const r = await api(`/detections?camera_id=${c.id}&since=${since}&limit=200`, token)
    for (const d of r.body.items ?? []) {
      if (d.grammar_valid && /^GJ\d{2}[A-Z]{1,3}\d{4}$/.test(d.plate ?? '')) reads.push(d)
    }
  }
  const byPlate = new Map()
  for (const d of reads) {
    const e = byPlate.get(d.plate) ?? { plate: d.plate, n: 0, conf: 0 }
    e.n += 1
    e.conf = Math.max(e.conf, d.plate_confidence ?? 0)
    byPlate.set(d.plate, e)
  }
  return [...byPlate.values()].sort((a, b) => b.n - a.n || b.conf - a.conf)[0]?.plate ?? null
}

const gridCount = cameras.filter((c) => c.vms_vendor === 'hosted_grid' || c.camera_code.startsWith('SBX-')).length

/** A plate the recorded clip is reading right now, confidently, and nobody watches. */
async function clipPlate() {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const r = await api(`/detections?camera_id=${demoCamera.id}&since=${since}&limit=200`, token)
  const watched = new Set(
    rows((await api('/watchlist?active_only=true&limit=200', token)).body).map((e) => e.plate_normalised),
  )
  const counts = new Map()
  for (const d of r.body.items ?? []) {
    if (!d.plate || !d.grammar_valid || (d.plate_confidence ?? 0) < 0.85 || watched.has(d.plate)) continue
    counts.set(d.plate, (counts.get(d.plate) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** A plate on the clip with "possibly the same vehicle" candidates, for that panel. */
async function candidatePlate(exclude) {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const r = await api(`/detections?camera_id=${demoCamera.id}&since=${since}&limit=200`, token)
  const counts = new Map()
  for (const d of r.body.items ?? []) {
    if (d.plate && d.grammar_valid && d.plate !== exclude) counts.set(d.plate, (counts.get(d.plate) ?? 0) + 1)
  }
  for (const [plate] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    const c = await api(`/vehicles/${plate}/candidates`, token)
    if ((c.body.total ?? 0) > 0) return plate
  }
  return null
}

const searchPlate = await gridPlate()
const watchPlate = await clipPlate()
const candPlate = await candidatePlate(watchPlate)
const personAlarm = ((await api('/alerts?limit=100', token)).body.items ?? []).find(
  (a) => a.alert_type === 'person_match',
)
log(`plates: search ${searchPlate ?? '—'} · watch ${watchPlate ?? '—'} · candidates ${candPlate ?? '—'}`)
if (!watchPlate) throw new Error(`${DEMO_CAMERA} has read no confident plate in 10 min: is the clip publishing?`)

// ── The browser, recording ──────────────────────────────────────────────────

const browser = await launch({ headed: args.includes('--headed') })
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: WORK, size: { width: W, height: H } },
  acceptDownloads: true,
})
await guardGrid(context)
const page = await context.newPage()
const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))

const TOTAL = 12
let stepNo = 0
let watchId = null
const startedAt = Date.now()

/** The caption bar: one line saying what this step shows. Text only, never HTML. */
async function caption(text, { label, pos = 'bottom' } = {}) {
  await page
    .evaluate(
      ({ text, label, pos }) => {
        let bar = document.getElementById('demo-caption')
        if (!bar) {
          bar = document.createElement('div')
          bar.id = 'demo-caption'
          document.body.appendChild(bar)
        }
        bar.style.cssText = [
          'position:fixed',
          'left:50%',
          'transform:translateX(-50%)',
          pos === 'top' ? 'top:62px' : 'bottom:18px',
          'z-index:2147483647',
          'max-width:1240px',
          'width:max-content',
          'pointer-events:none',
          'background:rgba(5,9,16,0.93)',
          'color:#E8EEF6',
          'border:1px solid rgba(92,200,255,0.6)',
          'border-radius:10px',
          'padding:11px 18px',
          "font:500 18px/1.4 'IBM Plex Sans',system-ui,sans-serif",
          'box-shadow:0 10px 32px rgba(0,0,0,0.55)',
          'display:flex',
          'gap:14px',
          'align-items:baseline',
        ].join(';')
        bar.replaceChildren()
        const tag = document.createElement('span')
        tag.textContent = label
        tag.style.cssText =
          "font:600 13px/1 'IBM Plex Mono',ui-monospace,monospace;color:#5CC8FF;letter-spacing:0.06em;white-space:nowrap"
        const body = document.createElement('span')
        body.textContent = text
        bar.append(tag, body)
      },
      { text, label: label ?? `${stepNo} / ${TOTAL}`, pos },
    )
    .catch(() => {})
}

/** A full-screen card for the opening and closing seconds. */
async function card(lines, ms) {
  await page.evaluate((lines) => {
    const el = document.createElement('div')
    el.id = 'demo-card'
    el.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#070B12;color:#E8EEF6;display:flex;flex-direction:column;justify-content:center;padding:0 140px;gap:18px;font-family:"IBM Plex Sans",system-ui,sans-serif'
    lines.forEach(([text, size, colour], i) => {
      const p = document.createElement('div')
      p.textContent = text
      p.style.cssText = `font-size:${size}px;line-height:1.3;color:${colour ?? '#E8EEF6'};font-weight:${i === 0 ? 650 : 400}`
      el.appendChild(p)
    })
    document.body.appendChild(el)
  }, lines)
  await page.waitForTimeout(ms)
  await page.evaluate(() => document.getElementById('demo-card')?.remove()).catch(() => {})
}

/** Draw the eye to an element for a moment. */
async function point(locator, ms = 1800) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 4000 })
    await locator.evaluate((el, ms) => {
      const before = [el.style.outline, el.style.outlineOffset]
      el.style.outline = '3px solid #5CC8FF'
      el.style.outlineOffset = '3px'
      setTimeout(() => {
        el.style.outline = before[0]
        el.style.outlineOffset = before[1]
      }, ms)
    }, ms)
  } catch {
    /* nothing to point at: the caption still says what the step is */
  }
}

async function go(path, text, opts) {
  await page.goto(`${BASE}${path}`)
  await caption(text, opts)
}

async function step(name, fn) {
  stepNo += 1
  const t = Date.now()
  try {
    const detail = await fn()
    log(`✓ ${stepNo} ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    const message = String(err?.message ?? err).split('\n')[0]
    problems.push(`${name}: ${message}`)
    log(`✗ ${stepNo} ${name} — ${message}`)
  }
}

const ist = (d = new Date()) =>
  d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hourCycle: 'h23', dateStyle: 'medium', timeStyle: 'short' })

try {
  await step('sign-in', async () => {
    await page.goto(BASE)
    await page.getByLabel(/username/i).waitFor({ timeout: 15000 })
    await card(
      [
        ['Contrail', 54],
        ['Federated CCTV intelligence for Gujarat — the Sentinel live test, walked on the running stack', 26, '#B8C4D4'],
        [`Recorded ${ist()} IST · one laptop · the organisers' grid + our own recorded feed`, 20, '#5CC8FF'],
      ],
      4500,
    )
    await caption('Sign in. Named accounts only — every search, stream open and watchlist change below is audited.')
    const user = page.getByLabel(/username/i)
    await user.fill('')
    await user.pressSequentially(username, { delay: 60 })
    await page.getByLabel(/^password/i).fill(password)
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL(/\/dashboard/, { timeout: 20000 })
  })

  await step('command', async () => {
    await caption(
      'Command — every federated camera on one map of Gujarat; tiles count what is happening now.',
      { pos: 'top' },
    )
    await page.getByText('Feeds answering').waitFor({ timeout: 15000 })
    await page.locator('.maplibregl-canvas').first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(4000)
    const strip = page.getByRole('region', { name: 'Reading now' })
    await caption('"Reading now": plates arrive as the edge workers read them — about 2 KB per vehicle, never video.', {
      pos: 'top',
    })
    await point(strip, 2500)
    await page.waitForTimeout(4500)
  })

  await step('palette', async () => {
    if (!searchPlate) throw new Error('no grid plate to search for')
    await caption(`⌘K from any screen — type a plate read on the organisers' grid (${searchPlate}).`, { pos: 'top' })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
    const input = page.getByRole('textbox', { name: 'Search' })
    await input.waitFor({ timeout: 5000 })
    await input.pressSequentially(searchPlate, { delay: 110 })
    await page.waitForTimeout(900)
    await input.press('Enter')
    await page.waitForURL(/\/vehicles\?plate=/, { timeout: 15000 })
    return searchPlate
  })

  await step('investigate', async () => {
    const band = page.locator('section[aria-label="Vehicle"]').first()
    await band.waitFor({ timeout: 20000 })
    await caption('Investigate — every sighting with time (IST), camera, place and read confidence; the route on the map.')
    await page.waitForTimeout(4500)
    const registry = page.getByRole('region', { name: /^Registry record for/ })
    await caption(
      'Registry card — VAHAN and eGujCop answers from labelled reference data, never presented as a live query.',
    )
    await point(registry, 3000)
    await page.waitForTimeout(4500)
    await caption(
      'Pursue — predicts the cameras it can reach next. Shown here, not started: nothing is pinned.',
    )
    await page.getByRole('button', { name: /^pursue$/i }).click()
    const panel = page.getByRole('region', { name: 'Pursuit' })
    await panel.getByText(/Starting would pin/).waitFor({ timeout: 20000 })
    await point(panel, 3000)
    await page.waitForTimeout(6000)
    const running = (await api('/pursuits', token)).body.pursuits ?? []
    if (running.some((p) => p.plate === searchPlate)) throw new Error('a pursuit is running for the plate')
    await panel.getByRole('button', { name: 'Close the pursuit panel' }).click()
  })

  await step('candidates-and-csv', async () => {
    const plate = candPlate ?? searchPlate
    await go(
      `/vehicles?plate=${plate}`,
      'Possibly the same vehicle — reads one or two characters away, each with its reasons; included only by an analyst.',
    )
    const list = page.getByRole('region', { name: 'Possibly the same vehicle' })
    if (candPlate) {
      await list.waitFor({ timeout: 20000 })
      await point(list, 3000)
      await page.waitForTimeout(5000)
    } else {
      await page.locator('section[aria-label="Vehicle"]').first().waitFor({ timeout: 20000 })
      await page.waitForTimeout(3000)
    }
    await caption('CSV — every visit in order with the leg to it. Opening it is a plate search, so it is audited.')
    const button = page.getByRole('button', { name: /^csv$/i }).first()
    await point(button, 1500)
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), button.click()])
    await download.saveAs(`${WORK}route-${plate}.csv`)
    await page.waitForTimeout(3000)
    return plate
  })

  await step('live', async () => {
    await go(
      `/anpr?camera=${DEMO_CAMERA}`,
      'Live — our own feed: a recorded clip (a UK road) replayed as a camera. Vehicles boxed, plates read at the edge.',
    )
    const video = page.locator('video').first()
    await video.waitFor({ timeout: 20000 })
    // Polled from here, not with waitForFunction: the app's CSP forbids eval,
    // and the recording runs the app exactly as shipped.
    const deadline = Date.now() + 30000
    while (!(await video.evaluate((v) => v.readyState >= 2 && v.currentTime > 1).catch(() => false))) {
      if (Date.now() > deadline) throw new Error('the video did not start within 30 s')
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(9000)
    return watchPlate
  })

  await step('watchlist-add', async () => {
    await go(
      '/watchlist',
      `Watchlist — add ${watchPlate}, a plate the clip is reading now: category, priority and a case reference.`,
    )
    const form = page.getByRole('complementary', { name: 'Add a plate' })
    await form.waitFor({ timeout: 15000 })
    const inputs = form.locator('input')
    await inputs.nth(0).pressSequentially(watchPlate, { delay: 90 })
    await form.locator('select').nth(0).selectOption('stolen')
    await form.locator('select').nth(1).selectOption('critical')
    await inputs.nth(1).fill(CASE_REF)
    await inputs.nth(2).fill('Submission video — a recorded-clip plate, not a real case')
    await page.waitForTimeout(1500)
    await form.getByRole('button', { name: /add to watchlist/i }).click()
    for (let i = 0; i < 20 && !watchId; i += 1) {
      await page.waitForTimeout(500)
      const found = rows((await api(`/watchlist?plate=${watchPlate}&active_only=true&limit=10`, token)).body)
      watchId = found.find((e) => e.case_ref === CASE_REF)?.id ?? null
    }
    if (!watchId) throw new Error('the watchlist entry did not appear')
    await page.waitForTimeout(2000)
  })

  let alarmId = null
  await step('alarm', async () => {
    if (!watchId) throw new Error('nothing watched')
    await go(
      '/alerts',
      'Waiting for the clip to come round. Nothing is injected: the alarm is raised by the pipeline itself.',
    )
    const started = Date.now()
    while (!alarmId && Date.now() - started < 180000) {
      await page.waitForTimeout(1500)
      const open = (await api('/alerts?open_only=true&limit=50', token)).body.items ?? []
      alarmId = open.find((a) => a.watchlist_id === watchId)?.id ?? null
    }
    if (!alarmId) throw new Error('no alarm within 3 minutes')
    const seconds = Math.round((Date.now() - started) / 1000)
    await page.locator('.plate-chip.is-watched').first().waitFor({ timeout: 15000 }).catch(() => {})
    await caption(`Alarm — raised ${seconds} s after the plate was watched, critical, at the top of the queue.`)
    await page.waitForTimeout(3500)
    return `${seconds} s`
  })

  await step('alarm-detail', async () => {
    if (!alarmId) throw new Error('no alarm to open')
    await go(
      `/alerts?alert=${alarmId}`,
      'The detail — plate crop, camera, time, confidence, why it fired, what to do, and the case it belongs to.',
    )
    await page.getByText('Why it fired').first().waitFor({ timeout: 15000 })
    await point(page.getByText('Why it fired').first(), 2500)
    await page.waitForTimeout(8000)
  })

  await step('persons', async () => {
    await go(
      '/persons',
      'Persons watchlist — enrolled by one account, approved by another; purpose, case and expiry required.',
    )
    await page.getByText(/DEMO\/PERSONS\/001/).first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(5000)
    if (!personAlarm) return 'no face match on record'
    await go(
      `/alerts?alert=${personAlarm.id}&status=all`,
      'A possible face match on recorded stock footage (fictional case): similarity against threshold, never an identification.',
    )
    const notice = page.getByText(/must confirm/i).first()
    await notice.waitFor({ timeout: 15000 })
    await point(notice, 3000)
    await caption('"A person must confirm this match before anyone acts." Faces that match nothing are never stored.')
    await page.waitForTimeout(6000)
  })

  await step('network', async () => {
    await go(
      '/map',
      `Network — the GIS registry: ${cameras.length} cameras, ${gridCount} federated from the organisers' catalogue; filter by department or status.`,
    )
    await page.locator('.maplibregl-canvas').first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(8000)
  })

  await step('insights-and-audit', async () => {
    await go(
      '/traffic',
      'Insights — vehicle counts, flow, congestion and a short forecast, each with its factors; gaps labelled, not filled.',
    )
    await page.getByText(/vehicles observed/i).first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(7000)
    await go(
      '/audit',
      'Audit — every search, stream open and watchlist change from this recording, with who, when and from where.',
    )
    await page.getByRole('table').first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(2500)
    // Only this account's rows: the searches, stream opens and watchlist change above.
    const who = page.getByPlaceholder('exact username')
    await who.pressSequentially(username, { delay: 80 })
    await who.press('Enter')
    await page.waitForTimeout(5500)
    await card(
      [
        ['Contrail', 44],
        ['Federate what departments already run · AI at the edge · events, not video, to the centre', 24, '#B8C4D4'],
        ['Demo entries removed after recording: watchlist entry retired, its alarm closed with a note.', 20, '#5CC8FF'],
      ],
      4000,
    )
  })
} finally {
  // Clean up whatever happened above: close the alarm as a recording, retire the entry.
  if (watchId) {
    const open = (await api('/alerts?open_only=true&limit=100', token)).body.items ?? []
    for (const a of open.filter((x) => x.watchlist_id === watchId)) {
      const r = await api(`/alerts/${a.id}/transition`, token, {
        method: 'POST',
        body: JSON.stringify({ status: 'closed', notes: 'Test alarm raised while recording the submission video' }),
      })
      log(`closed alarm ${a.id} (${r.status})`)
    }
    const retired = await api(`/watchlist/${watchId}`, token, { method: 'DELETE' })
    log(`retired watchlist entry ${watchId} (${retired.status})`)
  }
  await context.close()
  await browser.close()
}

// ── The file ────────────────────────────────────────────────────────────────

const stamp = new Date(startedAt)
  .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata', hourCycle: 'h23' })
  .replace(/[-: ]/g, '')
  .slice(0, 12)
const webm = `${OUT}/contrail-demo-${stamp}.webm`
copyFileSync(await page.video().path(), webm)
let final = webm
const hasFfmpeg = spawnSync('which', ['ffmpeg']).status === 0
if (hasFfmpeg && !args.includes('--no-mp4')) {
  const mp4 = webm.replace(/\.webm$/, '.mp4')
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4],
    { stdio: 'inherit' },
  )
  final = mp4
}
let duration = '?'
if (spawnSync('which', ['ffprobe']).status === 0) {
  duration = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', final])
    .toString()
    .trim()
}
log(`video: ${final} · ${duration} s`)
if (problems.length) {
  log(`${problems.length} problem(s):`)
  for (const p of problems) log('  ', p)
}
process.exit(problems.length ? 1 : 0)
