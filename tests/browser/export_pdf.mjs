// Export the submission documents to PDF: Markdown → HTML → headless Chrome.
//
//   node export_pdf.mjs [--out ../../docs/submission/pdf] [doc.md ...]
//
// With no documents named it exports the HLD, INFRASTRUCTURE, REQUIREMENTS,
// SECURITY, the deck and the output report. Markdown is rendered locally with
// `marked` (MIT), Mermaid diagrams with `mermaid` (MIT) inside the page, and
// Chrome prints with a print stylesheet: A4, running header and page numbers,
// tables that repeat their header row, headings kept with what follows.
//
// The deck (docs/submission/DECK.md) is exported twice: DECK.pdf, the whole
// document with speaker notes, and DECK-slides.pdf, one 16:9 page per
// "## Slide N — Title" section showing its title, the points under
// "**On the slide**", and its visual — the image on its "**Visual:**" line,
// else the first table in the section — with the sources in small print.
//
// Nothing is fetched from the network: fonts come from the web app's bundled
// @fontsource packages when they are installed, else the system's.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Marked } from 'marked'

import { launch } from './session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}
const OUT = resolve(opt('out', `${REPO}/docs/submission/pdf`))
const WORK = `${HERE}/out/pdf-work`
const DOCS = (args.length ? args : [
  'docs/HLD.md',
  'docs/INFRASTRUCTURE.md',
  'docs/REQUIREMENTS.md',
  'docs/SECURITY.md',
  'docs/submission/DECK.md',
  'docs/submission/OUTPUT_REPORT.md',
]).map((p) => resolve(REPO, p))
const EXPORTED = new Set(DOCS.map((d) => basename(d)))
const MERMAID = `${HERE}/node_modules/mermaid/dist/mermaid.min.js`
const EVENT = 'Gujarat Police CCTV Hackathon “Sentinel” · 12–13 Oct 2026'

mkdirSync(OUT, { recursive: true })
mkdirSync(WORK, { recursive: true })

// ── Markdown ───────────────────────────────────────────────────────────────

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** GitHub's heading anchors, so in-document links resolve in the PDF. */
function slugger() {
  const seen = new Map()
  return (text) => {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

function markdown() {
  const slug = slugger()
  const md = new Marked({ gfm: true })
  md.use({
    renderer: {
      code({ text, lang }) {
        if ((lang ?? '').trim() === 'mermaid') return `<figure class="diagram"><pre class="mermaid">${escapeHtml(text)}</pre></figure>\n`
        return `<pre><code>${escapeHtml(text)}</code></pre>\n`
      },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        return `<h${depth} id="${slug(inner)}">${inner}</h${depth}>\n`
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        // A link to another exported document points at its PDF instead.
        const m = /^([^#:]*?)([^/#]+\.md)(#.*)?$/.exec(href ?? '')
        let target = href
        if (m && EXPORTED.has(m[2])) target = `${m[2].replace(/\.md$/, '.pdf')}${m[3] ?? ''}`
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</a>`
      },
    },
  })
  return md
}

// ── Styles ─────────────────────────────────────────────────────────────────

function fontFaces() {
  const font = (pkg, file, family, weight) => {
    const path = `${REPO}/web/node_modules/@fontsource/${pkg}/files/${file}`
    return existsSync(path)
      ? `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url('${pathToFileURL(path)}') format('woff2')}`
      : ''
  }
  return [
    font('ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2', 'IBM Plex Sans', 400),
    font('ibm-plex-sans', 'ibm-plex-sans-latin-500-normal.woff2', 'IBM Plex Sans', 500),
    font('ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2', 'IBM Plex Sans', 600),
    font('ibm-plex-sans', 'ibm-plex-sans-latin-700-normal.woff2', 'IBM Plex Sans', 700),
    font('ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2', 'IBM Plex Mono', 400),
    font('ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2', 'IBM Plex Mono', 500),
  ].join('\n')
}

const SANS = `'IBM Plex Sans', -apple-system, 'Helvetica Neue', Arial, sans-serif`
const MONO = `'IBM Plex Mono', ui-monospace, Menlo, monospace`

const DOC_CSS = `
${fontFaces()}
@page { size: A4; margin: 20mm 15mm 18mm 15mm; }
:root { --ink:#0f172a; --muted:#475569; --faint:#64748b; --rule:#cbd5e1; --soft:#f1f5f9; --accent:#0369a1; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: ${SANS}; color: var(--ink); background: #fff; font-size: 9.6pt; line-height: 1.5; margin: 0; }
h1, h2, h3, h4 { line-height: 1.25; break-after: avoid; page-break-after: avoid; font-weight: 650; }
h1 { font-size: 21pt; margin: 0 0 6pt; letter-spacing: -0.01em; }
h1 + p, h1 + p + p { color: var(--muted); }
h2 { font-size: 14pt; margin: 20pt 0 6pt; padding-top: 8pt; border-top: 1.5px solid var(--ink); }
h3 { font-size: 11.5pt; margin: 14pt 0 4pt; }
h4 { font-size: 10pt; margin: 10pt 0 3pt; }
p, li { orphans: 3; widows: 3; }
p { margin: 0 0 6pt; }
ul, ol { margin: 0 0 6pt; padding-left: 16pt; }
li { margin: 1.5pt 0; }
a { color: var(--accent); text-decoration: none; }
strong { font-weight: 650; }
code { font-family: ${MONO}; font-size: 8.6pt; background: var(--soft); padding: 0.5pt 3pt; border-radius: 3px; overflow-wrap: anywhere; }
pre { font-family: ${MONO}; font-size: 7.9pt; line-height: 1.4; background: var(--soft); border: 1px solid #e2e8f0; border-radius: 4px; padding: 7pt 9pt; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
pre code { background: none; padding: 0; font-size: inherit; }
blockquote { margin: 8pt 0; padding: 4pt 10pt; border-left: 3px solid var(--accent); background: #f8fafc; color: var(--ink); }
blockquote h1 { font-size: 13pt; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 14pt 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 8.3pt; line-height: 1.38; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th { background: var(--soft); text-align: left; font-weight: 600; }
th, td { border: 1px solid var(--rule); padding: 3pt 5pt; vertical-align: top; overflow-wrap: break-word; }
img { max-width: 100%; max-height: 110mm; border: 1px solid var(--rule); border-radius: 4px; break-inside: avoid; }
figure.diagram { margin: 8pt 0 12pt; text-align: center; break-inside: avoid; page-break-inside: avoid; }
figure.diagram pre.mermaid { background: none; border: 0; padding: 0; white-space: pre; }
figure.diagram svg { max-width: 100% !important; height: auto; max-height: 230mm; }
.mermaid-error { color: #b91c1c; font-size: 8pt; }
`

const SLIDE_CSS = `
${fontFaces()}
@page { size: 13.333in 7.5in; margin: 0; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #0b1220; font-family: ${SANS}; color: #e6edf5; }
.slide { width: 13.333in; height: 7.5in; box-sizing: border-box; padding: 0.42in 0.55in 0.36in; display: flex; flex-direction: column; break-after: page; page-break-after: always; position: relative; overflow: hidden;
  background: radial-gradient(1200px 500px at 85% -10%, rgba(92,200,255,0.10), transparent 60%), #0b1220; }
.slide:last-child { break-after: auto; page-break-after: auto; }
.top { display: flex; justify-content: space-between; align-items: center; font: 600 10.5pt/1 ${MONO}; letter-spacing: 0.08em; color: #5cc8ff; text-transform: uppercase; }
.top .num { color: #93a4b8; }
.trail { height: 2px; margin: 9pt 0 12pt; background: linear-gradient(90deg, #5cc8ff, rgba(92,200,255,0)); }
h1 { font-size: 25pt; line-height: 1.15; margin: 0 0 14pt; font-weight: 650; letter-spacing: -0.01em; color: #f4f8fc; }
.body { flex: 1; display: flex; gap: 0.38in; min-height: 0; }
.points { flex: 0 0 36%; display: flex; flex-direction: column; gap: 9pt; }
.body.text-only .points { flex: 1; gap: 14pt; }
.points ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10pt; }
.points li { position: relative; padding-left: 16pt; font-size: 14pt; line-height: 1.36; color: #dbe4ee; }
.body.text-only .points li { font-size: 19pt; }
.points li::before { content: ''; position: absolute; left: 0; top: 0.55em; width: 7pt; height: 7pt; border-radius: 50%; background: #5cc8ff; }
.points strong { color: #ffffff; font-weight: 650; }
.points em { color: #9fdcff; font-style: normal; }
.points code, .visual code { font-family: ${MONO}; font-size: 0.86em; background: rgba(92,200,255,0.12); color: #bfe9ff; padding: 0 3pt; border-radius: 3px; }
.visual { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-start; gap: 6pt; }
.visual img { width: 100%; max-height: 4.85in; object-fit: contain; object-position: top left; border-radius: 8px; border: 1px solid rgba(147,164,184,0.35); box-shadow: 0 10px 30px rgba(0,0,0,0.45); background: #0f172a; }
.visual.light img { background: #fff; }
.visual .caption { font-size: 9.5pt; line-height: 1.35; color: #93a4b8; }
.visual table { border-collapse: collapse; width: 100%; font-size: 12.5pt; line-height: 1.3; }
.visual th { text-align: left; color: #5cc8ff; font: 600 9.5pt/1.2 ${MONO}; letter-spacing: 0.06em; text-transform: uppercase; padding: 6pt 8pt; border-bottom: 1.5px solid rgba(92,200,255,0.55); }
.visual td { padding: 7pt 8pt; border-bottom: 1px solid rgba(147,164,184,0.22); color: #dbe4ee; vertical-align: top; }
.visual td strong { color: #fff; }
.sources { margin-top: 10pt; font-size: 8.5pt; line-height: 1.35; color: #6b7c90; }
.sources code { font-family: ${MONO}; font-size: 0.95em; color: #8aa0b6; }
.cover h1 { font-size: 46pt; margin-bottom: 4pt; color: #5cc8ff; }
.cover .lede { font-size: 15pt; color: #9fb3c8; margin: 0 0 18pt; max-width: 7in; }
`

function page({ title, body, css, base }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<base href="${base}">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head><body>${body}</body></html>`
}

// ── The deck as slides ─────────────────────────────────────────────────────

function slides(source) {
  const md = markdown()
  const sections = source.split(/^## (?=Slide \d+)/m).slice(1)
  const total = sections.length
  const html = sections.map((section, index) => {
    const [headingLine, ...rest] = section.split('\n')
    const m = /^Slide (\d+)\s*[—-]\s*(.+)$/.exec(headingLine.trim())
    const num = m ? Number(m[1]) : index + 1
    const title = m ? m[2] : headingLine
    // Only the slide's own section, not the appendix that may follow the last one.
    const text = rest.join('\n').split(/^---\s*$/m)[0]
    const tokens = md.lexer(text)

    let points = []
    let visual = null
    let caption = ''
    let table = null
    let sources = ''
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]
      if (t.type === 'paragraph' && /^\*\*On the slide\*\*/.test(t.raw.trim())) {
        const list = tokens.slice(i + 1).find((x) => x.type === 'list')
        if (list) points = list.items.map((item) => md.parseInline(item.text))
      }
      if (t.type === 'paragraph' && /^\*\*Visual:\*\*/.test(t.raw.trim())) {
        const img = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(t.raw)
        if (img) {
          visual = { alt: img[1], src: img[2] }
          caption = md.parseInline(
            t.raw
              .replace(/^\*\*Visual:\*\*\s*/, '')
              .replace(img[0], '')
              .replace(/^\s*[—-]\s*/, '')
              .trim(),
          )
        }
      }
      if (t.type === 'table' && !table) table = md.parser([t])
      if (t.type === 'paragraph' && /^\*\*Sources\.\*\*/.test(t.raw.trim())) {
        sources = md.parseInline(t.raw.replace(/^\*\*Sources\.\*\*\s*/, '').trim())
      }
    }

    const header = `<div class="top"><span>Contrail · Sentinel 2026</span><span class="num">${String(num).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span></div><div class="trail"></div>`
    const list = `<ul>${points.map((p) => `<li>${p}</li>`).join('')}</ul>`
    let right = ''
    if (visual) {
      const light = /architecture|workflow/.test(visual.src) ? ' light' : ''
      right = `<div class="visual${light}"><img src="${escapeHtml(visual.src)}" alt="${escapeHtml(visual.alt)}">${caption ? `<div class="caption">${caption}</div>` : ''}</div>`
    } else if (table) {
      right = `<div class="visual">${table}</div>`
    }
    // The first slide is the cover: the name large, the rest of its title as the lede.
    const cover = num === 1
    const [name, ...lede] = title.split(/:\s*/)
    const heading = cover && lede.length
      ? `<h1>${md.parseInline(name)}</h1><p class="lede">${md.parseInline(lede.join(': '))}</p>`
      : `<h1>${md.parseInline(title)}</h1>`
    return `<section class="slide${cover ? ' cover' : ''}">
${header}
${heading}
<div class="body${right ? '' : ' text-only'}"><div class="points">${list}</div>${right}</div>
${sources ? `<div class="sources">Sources: ${sources}</div>` : ''}
</section>`
  })
  return html.join('\n')
}

// ── Printing ───────────────────────────────────────────────────────────────

const browser = await launch()
const context = await browser.newContext()
const pageTab = await context.newPage()
const problems = []
pageTab.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))

async function print({ html, name, pdf }) {
  const file = `${WORK}/${name}.html`
  writeFileSync(file, html)
  await pageTab.goto(pathToFileURL(file).href, { waitUntil: 'load' })
  const diagrams = await pageTab.locator('pre.mermaid').count()
  if (diagrams) {
    await pageTab.addScriptTag({ path: MERMAID })
    const failed = await pageTab.evaluate(async () => {
      const errors = []
      // eslint-disable-next-line no-undef
      mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict', fontFamily: 'IBM Plex Sans, Helvetica, Arial, sans-serif' })
      for (const el of document.querySelectorAll('pre.mermaid')) {
        try {
          // eslint-disable-next-line no-undef
          await mermaid.run({ nodes: [el] })
        } catch (err) {
          errors.push(String(err?.message ?? err).split('\n')[0])
          el.insertAdjacentHTML('afterend', '<div class="mermaid-error">Diagram could not be rendered; its source is shown above.</div>')
        }
      }
      return errors
    })
    for (const f of failed) problems.push(`${name}: mermaid: ${f}`)
  }
  await pageTab.evaluate(() => document.fonts.ready)
  await pageTab.waitForTimeout(300)
  await pageTab.pdf({ path: `${OUT}/${name}.pdf`, ...pdf })
  return diagrams
}

const header = (title) => `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:7pt;color:#64748b;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span>Contrail — ${escapeHtml(title)}</span><span>${EVENT}</span></div>`
const footer = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:7pt;color:#64748b;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span>Contrail · branch sentinel-gj · printed <span class="date"></span></span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`

const done = []
for (const doc of DOCS) {
  const source = readFileSync(doc, 'utf8')
  const name = basename(doc, '.md')
  const titleLine = /^#\s+(.+)$/m.exec(source)?.[1] ?? name
  const title = titleLine.replace(/[*`]/g, '')
  const base = pathToFileURL(`${dirname(doc)}/`).href
  const body = markdown().parse(source)
  const diagrams = await print({
    html: page({ title, body: `<main>${body}</main>`, css: DOC_CSS, base }),
    name,
    pdf: {
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: header(name === 'DECK' ? 'Solution presentation (with speaker notes)' : title.replace(/^Contrail\s*[—-]\s*/, '')),
      footerTemplate: footer,
      margin: { top: '20mm', bottom: '18mm', left: '15mm', right: '15mm' },
    },
  })
  done.push(`${OUT}/${name}.pdf${diagrams ? ` (${diagrams} diagram${diagrams === 1 ? '' : 's'})` : ''}`)

  if (name === 'DECK') {
    await print({
      html: page({ title: 'Contrail — slides', body: slides(source), css: SLIDE_CSS, base }),
      name: 'DECK-slides',
      pdf: { width: '13.333in', height: '7.5in', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } },
    })
    done.push(`${OUT}/DECK-slides.pdf`)
  }
}

await browser.close()
for (const d of done) console.log(`wrote ${d}`)
if (problems.length) {
  console.log(`${problems.length} problem(s):`)
  for (const p of problems) console.log('  ', p)
  process.exit(1)
}
