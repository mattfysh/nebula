import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import deflist from 'markdown-it-deflist'
import taskLists from 'markdown-it-task-lists'
import { katex } from '@mdit/plugin-katex'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false })
  .use(footnote)
  .use(deflist)
  .use(taskLists, { enabled: false, label: true, labelAfter: true })
  .use(katex, { throwOnError: false, strict: 'warn', trust: false })
const validateLink = md.validateLink.bind(md)
md.validateLink = (url) => validateLink(url) && !/^data:/i.test(url)

// Open external links safely. MarkdownIt's URL normalizer and validator reject
// dangerous schemes; raw model-authored HTML remains disabled above.
const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const href = token.attrGet('href') || ''
  if (/^https?:/i.test(href)) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}
const defaultImage = md.renderer.rules.image || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('loading', 'lazy')
  tokens[idx].attrSet('decoding', 'async')
  return defaultImage(tokens, idx, options, env, self)
}

// GitHub-style alerts are blockquotes whose first inline token starts with
// [!TYPE]. Restrict the type to a known visual/accessibility vocabulary.
const alerts = new Set(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])
md.core.ruler.after('block', 'successor_alerts', (state) => {
  for (let i = 0; i < state.tokens.length - 2; i++) {
    if (state.tokens[i].type !== 'blockquote_open') continue
    const paragraph = state.tokens[i + 1]
    const inline = state.tokens[i + 2]
    if (paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline') continue
    const match = inline.content.match(/^\[!([A-Z]+)\](?:\n|\s+)([\s\S]*)$/)
    if (!match || !alerts.has(match[1])) continue
    state.tokens[i].attrJoin('class', `markdown-alert markdown-alert-${match[1].toLowerCase()}`)
    const title = match[1][0] + match[1].slice(1).toLowerCase()
    inline.content = match[2]
    inline.children = []
    state.md.inline.parse(match[2], state.md, state.env, inline.children)
    const heading = new state.Token('html_inline', '', 0)
    heading.content = `<strong class="markdown-alert-title">${title}</strong>\n`
    inline.children.unshift(heading)
  }
})

function renderToHtml(source) { return md.render(String(source)) }
function render(parent, source) { parent.innerHTML = renderToHtml(source) }
globalThis.successorMarkdown = { render, renderToHtml }
