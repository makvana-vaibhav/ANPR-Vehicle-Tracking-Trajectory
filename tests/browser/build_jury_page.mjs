// Build the jury-round rehearsal page from docs/submission/JURY_PREP.md.
//
//   node build_jury_page.mjs <out.html> [--updates updates.md]
//
// Markdown is rendered here, at build time, so the page needs no runtime
// library: tables, code and Mermaid diagrams come out exactly as written. The
// question bank is parsed into cards (question, answer, proof, follow-up,
// owner, category) so the page can search, filter and quiz on it.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const out = process.argv[2]
const updatesArg = process.argv.indexOf('--updates')
const updatesMd = updatesArg > -1 ? readFileSync(process.argv[updatesArg + 1], 'utf8') : ''
if (!out) throw new Error('usage: node build_jury_page.mjs <out.html>')

const md = readFileSync(`${REPO}docs/submission/JURY_PREP.md`, 'utf8')
marked.setOptions({ gfm: true })

const unescape = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

function render(text) {
  let html = marked.parse(text)
  // Mermaid fences become blocks the viewer renders natively.
  html = html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_, code) => `<pre class="mermaid">${unescape(code)}</pre>`,
  )
  // Wide tables scroll inside their own box, never the page.
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>')
  // Local file links cannot open from the page; show them as code paths.
  html = html.replace(/<a href="(?!https?:|#)([^"]+)">([\s\S]*?)<\/a>/g, '<span class="path">$2</span>')
  return html
}

// ── Split into top-level sections ─────────────────────────────────────
const lines = md.split('\n')
const sections = [] // { title, body }
let current = { title: '_intro', body: [] }
for (const line of lines) {
  const m = /^## (.+)$/.exec(line)
  if (m) {
    sections.push(current)
    current = { title: m[1].trim(), body: [] }
  } else current.body.push(line)
}
sections.push(current)
const find = (prefix) => sections.find((s) => s.title.startsWith(prefix))
const bodyOf = (prefix) => (find(prefix)?.body ?? []).join('\n')

// The intro: drop the document's own H1 (the page has its own header).
const intro = sections[0].body.join('\n').replace(/^# .+\n/, '')

// ── Run of show: split 1.x subsections ────────────────────────────────
function subsections(text) {
  const out = []
  let cur = null
  for (const line of text.split('\n')) {
    const m = /^### (.+)$/.exec(line)
    if (m) {
      if (cur) out.push(cur)
      cur = { title: m[1].trim(), body: [] }
    } else if (cur) cur.body.push(line)
    else (out.pre ??= []).push(line)
  }
  if (cur) out.push(cur)
  return out
}
const runSubs = subsections(bodyOf('1. Run of show'))
const sub = (subs, prefix) => subs.find((s) => s.title.startsWith(prefix))?.body.join('\n') ?? ''

// ── Question bank ─────────────────────────────────────────────────────
const qText = bodyOf('4. Question bank')
const qPre = qText.split(/^### /m)[0]
const questions = []
const categories = []
for (const block of qText.split(/^### /m).slice(1)) {
  const nl = block.indexOf('\n')
  const catTitle = block.slice(0, nl).trim()
  const cat = catTitle.replace(/^4\.\d+\s+/, '').replace(/\s*\(owner:.*\)$/, '')
  categories.push(cat)
  const rest = block.slice(nl + 1)
  const parts = rest.split(/^(?=\*\*Q-)/m).filter((p) => p.startsWith('**Q-'))
  for (const p of parts) {
    const head = /^\*\*(Q-[A-Z]+\d+[a-z]?)\.\s+([\s\S]*?)\*\*\s*\n/.exec(p)
    if (!head) continue
    let [, id, title] = head
    let owner = ''
    const om = /\s*\[([A-D/ ,]+)\]\s*$/.exec(title)
    if (om) {
      owner = om[1].replace(/\s/g, '')
      title = title.slice(0, om.index)
    }
    const body = p.slice(head[0].length)
    const grab = (label, next) => {
      const re = new RegExp(`\\*\\*${label}\\*\\*\\s*([\\s\\S]*?)(?=${next}|$)`)
      return (re.exec(body)?.[1] ?? '').trim()
    }
    const answer = grab('A\\.', '\\*\\*Show:\\*\\*|\\*\\*If pressed:\\*\\*')
    const show = grab('Show:', '\\*\\*If pressed:\\*\\*')
    const pressed = grab('If pressed:', '\\n\\*\\*Q-|\\n### ')
    questions.push({
      id,
      title: title.trim(),
      owner,
      cat,
      answer: render(answer),
      show: show ? render(show) : '',
      pressed: pressed ? render(pressed) : '',
      text: `${id} ${title} ${answer} ${show} ${pressed}`.toLowerCase(),
    })
  }
}

// ── Assemble ──────────────────────────────────────────────────────────
const data = {
  built: new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date()),
  updates: updatesMd ? render(updatesMd) : '',
  intro: render(intro),
  readFirst: render(bodyOf('Read first')),
  roles: render(sub(runSubs, '1.1')),
  run25: render(sub(runSubs, '1.2')),
  run20: render(sub(runSubs, '1.3')),
  run30: render(sub(runSubs, '1.4')),
  cues: render(sub(runSubs, '1.5')),
  demo: render(bodyOf('2. The live demo')),
  proof: render(bodyOf('3. Proof it is real')),
  qPre: render(qPre),
  categories,
  questions,
  gaps: render(bodyOf('5. What we lack')),
  arch: render(bodyOf('6. Architecture and code tour')),
  scale: render(bodyOf('7. Scale, cost')),
  team: render(bodyOf('8. Our suggestions to the team')),
  appendixA: render(bodyOf('Appendix A')),
  appendixB: render(bodyOf('Appendix B')),
}

const template = readFileSync(new URL('./jury_template.html', import.meta.url), 'utf8')
// Mermaid blocks must be in the static HTML for the viewer to render them,
// so the architecture section is injected as HTML, not through the JSON.
const html = template
  .replace('<!--ARCH-->', data.arch)
  .replace('/*DATA*/null', JSON.stringify({ ...data, arch: undefined }).replace(/<\/script/gi, '<\\/script'))
writeFileSync(out, html)
console.log(`wrote ${out}: ${questions.length} questions in ${categories.length} categories, ${(html.length / 1024).toFixed(0)} KB`)
