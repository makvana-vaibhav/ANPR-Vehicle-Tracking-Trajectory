// Screenshot screens of the running app, signed in.
//
//   node shot.mjs [--base http://localhost:8080] [--out out/shots] [--size 1440x900]
//                 [--wait 6000] [--theme light|dark] page [page ...]
//
// --theme emulates the operating system's colour scheme (the app follows it
// unless a choice is stored), and suffixes each file name with the theme.
// A page is a path without its leading slash ("dashboard", "vehicles?plate=GJ01AB1234").
// Prints any console errors per page. Never opens grid cameras.
import { mkdirSync } from 'node:fs'

import { guardGrid, launch, login, signInByToken } from './session.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}
const BASE = opt('base', 'http://localhost:8080')
const OUT = opt('out', new URL('./out/shots', import.meta.url).pathname)
const [W, H] = opt('size', '1440x900').split('x').map(Number)
const WAIT = Number(opt('wait', '6000'))
const THEME = opt('theme', null)
const PAGES = args.length ? args : ['dashboard']

if (PAGES.some((p) => /camera=SBX-/i.test(p))) {
  throw new Error('Refusing to open a grid camera: the grid has a watch-time quota.')
}

mkdirSync(OUT, { recursive: true })
const { token } = await login()
const browser = await launch()
const context = await browser.newContext({
  viewport: { width: W, height: H },
  ...(THEME ? { colorScheme: THEME } : {}),
})
await guardGrid(context)
await signInByToken(context, token)
const page = await context.newPage()
let errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

for (const path of PAGES) {
  errors = []
  await page.goto(`${BASE}/${path}`)
  await page.waitForTimeout(WAIT)
  const file = `${OUT}/${path.replace(/[/?=&]/g, '_') || 'root'}${THEME ? `.${THEME}` : ''}.png`
  await page.screenshot({ path: file })
  console.log(`captured ${path} -> ${file}`)
  if (errors.length) console.log('  console errors:', [...new Set(errors)].slice(0, 5))
}
await browser.close()
