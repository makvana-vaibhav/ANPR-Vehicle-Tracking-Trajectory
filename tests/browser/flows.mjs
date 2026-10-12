// End-to-end flows against the running stack, in a real browser.
//
//   node flows.mjs [--base http://localhost:8080] [--only name,name] [--headed]
//
// Signs in through the real login form with the bootstrap admin from .env
// (never printed), then walks what an operator and a judge do: Command, the
// search palette, a vehicle's journey and its exports, live video, the
// watchlist-to-alarm moment, the network, traffic, the audit trail, sign-out.
// Every flow cleans up what it creates. Grid cameras are never opened.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { api, guardGrid, launch, login } from './session.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const BASE = opt('base', 'http://localhost:8080')
const ONLY = (opt('only', '') || '').split(',').filter(Boolean)
const SKIP = (opt('skip', '') || '').split(',').filter(Boolean)
const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const { token, username, password } = await login()
const results = []
const consoleErrors = []

const browser = await launch({ headed: args.includes('--headed') })
// bypassCSP lets the harness's own probes run; the app still runs as shipped.
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  bypassCSP: true,
})
await guardGrid(context)
const page = await context.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`[${new URL(page.url()).pathname}] ${m.text()}`)
})
page.on('pageerror', (e) => consoleErrors.push(`[${new URL(page.url()).pathname}] pageerror: ${e.message}`))

async function step(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return
  if (SKIP.includes(name)) return
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? '' })
    console.log(`  ✓ ${name} (${Date.now() - started} ms)${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    const message = String(err?.message ?? err).split('\n')[0]
    results.push({ name, ok: false, ms: Date.now() - started, detail: message })
    console.log(`  ✗ ${name} — ${message}`)
    await page.screenshot({ path: `${OUT}${name}.png` }).catch(() => {})
  }
}

const recent = (await api('/detections?readable_only=true&limit=100', token)).body.items ?? []
const samplePlate = recent.find((d) => d.plate && d.plate.length >= 6)?.plate
console.log(`Base ${BASE} · sample plate ${samplePlate ?? '—'}`)

await step('sign-in', async () => {
  await page.goto(BASE)
  await page.getByLabel(/username/i).fill(username)
  await page.getByLabel(/^password/i).fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 15000 })
  await page.getByRole('navigation', { name: 'Workspaces' }).waitFor({ timeout: 10000 })
  return 'landed on Command'
})

await step('command', async () => {
  await page.goto(`${BASE}/dashboard`)
  await page.getByText('Feeds answering').waitFor({ timeout: 15000 })
  await page.locator('.maplibregl-canvas').waitFor({ timeout: 15000 })
  const strip = page.getByRole('region', { name: 'Reading now' })
  await strip.locator('.plate-chip').first().waitFor({ timeout: 30000 })
  return `${await strip.locator('.plate-chip').count()} plates in the strip, map drawn`
})

await step('palette-plate', async () => {
  if (!samplePlate) throw new Error('no plate read recently to search for')
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('navigation', { name: 'Workspaces' }).waitFor()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  const input = page.getByRole('textbox', { name: 'Search' })
  await input.fill(samplePlate)
  await input.press('Enter')
  await page.waitForURL(new RegExp(`/vehicles\\?plate=${samplePlate}`), { timeout: 10000 })
  return page.url().replace(BASE, '')
})

await step('investigate-csv', async () => {
  if (!samplePlate) throw new Error('no plate')
  await page.goto(`${BASE}/vehicles?plate=${samplePlate}`)
  const button = page.getByRole('button', { name: /^csv$/i }).first()
  await button.waitFor({ timeout: 20000 })
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), button.click()])
  const file = `${OUT}route-${samplePlate}.csv`
  await download.saveAs(file)
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  if (lines.length < 2) throw new Error(`CSV has ${lines.length} line(s)`)
  return `${lines.length - 1} visit row(s)`
})

await step('report', async () => {
  if (!samplePlate) throw new Error('no plate')
  await page.goto(`${BASE}/reports/vehicle/${samplePlate}`)
  await page.locator('.plate-chip').first().waitFor({ timeout: 15000 })
  return 'printable report rendered'
})

await step('live-demo-camera', async () => {
  await page.goto(`${BASE}/anpr?camera=CAM-DEMO-01`)
  await page.locator('video').first().waitFor({ timeout: 20000 })
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video')
      return Boolean(v && v.readyState >= 2 && v.currentTime > 1)
    },
    null,
    { timeout: 30000 },
  )
  const t = await page.locator('video').first().evaluate((v) => v.currentTime.toFixed(1))
  return `video playing (t=${t}s)`
})

let watchId = null
await step('watchlist-alarm', async () => {
  // The judge moment: watch a plate the looping demo clip shows, and the
  // alarm raises itself the next time that car comes round.
  const counts = new Map()
  for (const d of recent) {
    if (d.camera_code === 'CAM-DEMO-01' && d.plate && (d.plate_confidence ?? 0) > 0.85) {
      counts.set(d.plate, (counts.get(d.plate) ?? 0) + 1)
    }
  }
  const plate = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!plate) throw new Error('no confidently read demo plate to watch')
  const created = await api('/watchlist', token, {
    method: 'POST',
    body: JSON.stringify({
      plate,
      category: 'stolen',
      priority: 'critical',
      case_ref: 'E2E/TEST/AUTO-REMOVED',
      remarks: 'Browser E2E flow — removed automatically',
    }),
  })
  if (created.status >= 300) throw new Error(`watchlist add ${created.status}: ${JSON.stringify(created.body).slice(0, 160)}`)
  watchId = created.body.id
  await page.goto(`${BASE}/alerts`)
  const started = Date.now()
  await page.locator('.plate-chip.is-watched').first().waitFor({ timeout: 180000 })
  return `alarm for ${plate} on screen ${Math.round((Date.now() - started) / 1000)} s after watching it`
})

if (watchId) {
  const open = (await api('/alerts?open_only=true&limit=100', token)).body.items ?? []
  for (const a of open.filter((x) => x.watchlist_id === watchId)) {
    await api(`/alerts/${a.id}/transition`, token, {
      method: 'POST',
      body: JSON.stringify({ status: 'false_positive', notes: 'Browser E2E test alarm' }),
    })
  }
  await api(`/watchlist/${watchId}`, token, { method: 'DELETE' })
}

await step('network', async () => {
  await page.goto(`${BASE}/map`)
  await page.locator('.maplibregl-canvas').waitFor({ timeout: 15000 })
  await page.goto(`${BASE}/cameras?filter=unplaced`)
  await page.getByText('SBX-cam20').first().waitFor({ timeout: 15000 })
  await page.goto(`${BASE}/health`)
  await page.getByText(/answering/i).first().waitFor({ timeout: 15000 })
  return 'map, unplaced filter, fleet health'
})

await step('insights', async () => {
  await page.goto(`${BASE}/traffic`)
  await page.getByText(/vehicles observed/i).first().waitFor({ timeout: 20000 })
  return 'traffic renders'
})

await step('audit', async () => {
  await page.goto(`${BASE}/audit`)
  await page.getByRole('table').first().waitFor({ timeout: 15000 })
  return 'audit trail renders'
})

await step('sign-out', async () => {
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('button', { name: /signed in as/i }).click()
  await page.getByRole('menuitem', { name: /sign out/i }).click()
  await page.getByRole('button', { name: /sign in/i }).waitFor({ timeout: 10000 })
  return 'back at sign-in'
})

await browser.close()

const failed = results.filter((r) => !r.ok)
writeFileSync(`${OUT}results.json`, JSON.stringify({ base: BASE, results, consoleErrors }, null, 2))
console.log(`\n${results.length - failed.length}/${results.length} flows passed`)
const unique = [...new Set(consoleErrors)]
if (unique.length) {
  console.log(`${unique.length} distinct console error(s):`)
  for (const e of unique.slice(0, 15)) console.log('  ', e.slice(0, 220))
}
process.exit(failed.length ? 1 : 0)
