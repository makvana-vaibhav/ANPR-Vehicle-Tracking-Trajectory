// Shared set-up for the browser tests: credentials, an API client, and a
// browser that can draw maps without a GPU.
import { chromium } from 'playwright-core'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** Values from the repo's .env, parsed the way a shell would read them. Never print them. */
export function envValues() {
  const text = readFileSync(`${REPO}.env`, 'utf8')
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line
          .slice(line.indexOf('=') + 1)
          .replace(/\s+#.*$/, '')
          .trim()
          .replace(/^["']|["']$/g, ''),
      ]),
  )
}

export const API = process.env.CONTRAIL_API ?? 'http://localhost:8000/api/v1'

export async function login() {
  const env = envValues()
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: env.BOOTSTRAP_ADMIN_USERNAME,
      password: env.BOOTSTRAP_ADMIN_PASSWORD,
    }),
  })
  const body = await response.json()
  if (!body.access_token) throw new Error(`login failed (${response.status})`)
  return { token: body.access_token, username: env.BOOTSTRAP_ADMIN_USERNAME, password: env.BOOTSTRAP_ADMIN_PASSWORD }
}

export async function api(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

export async function launch({ headed = false } = {}) {
  const executablePath = CHROME_PATHS.find((p) => existsSync(p))
  if (!executablePath) throw new Error('No Chrome found; set CHROME_PATH')
  return chromium.launch({
    executablePath,
    headless: !headed,
    // Software WebGL, so the maps draw on a machine (or CI box) without a GPU.
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
}

/**
 * Grid cameras have a strict watch-time quota and lock out on session churn:
 * a test must never open one. Every request to the grid's hosts is refused.
 */
export async function guardGrid(context) {
  await context.route(/103\.250\.160\.189|cctv\.corp8\.cloud/, (route) => route.abort())
}

/** Put a token where the app looks for it, before any page script runs. */
export async function signInByToken(context, token) {
  await context.addInitScript((t) => {
    try {
      sessionStorage.setItem('contrail.access_token', t)
    } catch {
      /* the page will show the sign-in form instead */
    }
  }, token)
}
