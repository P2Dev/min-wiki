import MarkdownIt from 'markdown-it';

export const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
const fence = md.renderer.rules.fence;
md.renderer.rules.fence = (...args) => fence(...args).replace('<pre>', '<pre tabindex="0" aria-label="Code example">');
const codeBlock = md.renderer.rules.code_block;
md.renderer.rules.code_block = (...args) => codeBlock(...args).replace('<pre>', '<pre tabindex="0" aria-label="Code example">');
md.renderer.rules.table_open = () => '<table tabindex="0" aria-label="Markdown table">\n';
const originalLink = md.renderer.rules.link_open || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const href = token.attrGet('href');
  const local = /^(?:\.\/)?([a-z0-9]+(?:-[a-z0-9]+)*)\.md(#[^\s]*)?$/.exec(href || '');
  if (local) token.attrSet('href', `/wiki/${local[1]}${local[2] || ''}`);
  return originalLink(tokens, index, options, env, renderer);
};
const plainInline = token => (token.children || []).map(child => child.type === 'image' ? child.content : ['text', 'code_inline'].includes(child.type) ? child.content : child.type.endsWith('break') ? ' ' : '').join('');

export function renderMarkdown(markdown, slug = '') {
  const tokens = md.parse(markdown, {});
  const firstHeading = tokens.findIndex(token => token.type === 'heading_open' && token.tag === 'h1');
  const title = firstHeading >= 0 ? plainInline(tokens[firstHeading + 1]) : slug.replace(/-/g, ' ');
  const outline = [];
  const used = new Set(['main', 'search']);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;
    const text = plainInline(tokens[index + 1]);
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    let id = base, suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id); token.attrSet('id', id);
    // The first H1 is presented as the article title; preserve its anchor there.
    if (index === firstHeading) continue;
    if (['h1', 'h2', 'h3'].includes(token.tag)) outline.push({ id, text, level: token.tag });
  }
  const titleId = firstHeading >= 0 ? tokens[firstHeading].attrGet('id') : 'page-title';
  if (firstHeading >= 0) tokens.splice(firstHeading, 3);
  const html = md.renderer.render(tokens, md.options, {});
  const summary = tokens.filter(token => token.type === 'inline').map(plainInline).find(text => text.trim()) || 'An empty page.';
  return { title, titleId, html, outline, summary: summary.slice(0, 180) };
}

function nav(pages, active) {
  return pages.map(page => `<a class="page-link" href="/wiki/${page.slug}" ${active === page.slug ? 'aria-current="page"' : ''}><span aria-hidden="true">▤</span>${escape(page.title)}</a>`).join('');
}
export function layout({ title, pages, active, content, outline = [], query = '' }) {
  const compactOutline = outline.length ? `<details class="compact-outline"><summary>On this page</summary><nav aria-label="Article sections">${outline.map(item => `<a href="#${escape(item.id)}">${escape(item.text)}</a>`).join('')}</nav></details>` : '';
  content = content.replace('<article class="prose">', () => `${compactOutline}<article class="prose">`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(title)} · min wiki</title><link rel="stylesheet" href="/assets/style.css"></head><body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">m<span>·</span></span>min wiki<span class="brand-label">A place for what you know.</span></a><a class="api-link" href="/guide">API guide <span aria-hidden="true">↗</span></a></header>
  <div class="workspace"><aside class="sidebar"><form role="search" action="/" method="get"><label for="search">Search the wiki</label><div class="search-row"><input id="search" name="q" type="search" placeholder="Find a page…" value="${escape(query)}" maxlength="200"><button type="submit" aria-label="Search">↵</button></div></form><details class="page-nav" open><summary>Pages <span>${pages.length}</span></summary><nav aria-label="Wiki pages"><a class="page-link all-pages" href="/" ${active === 'index' ? 'aria-current="page"' : ''}><span aria-hidden="true">⊞</span>All pages</a>${nav(pages, active)}</nav></details><div class="sidebar-note"><span class="status-dot"></span>Open to read.<br><span>Yours to build on.</span></div></aside>
  <main id="main" tabindex="-1">${content}</main>
  <aside class="outline" aria-label="On this page">${outline.length ? `<p class="eyebrow">On this page</p><nav>${outline.map(item => `<a class="${item.level === 'h3' ? 'subheading' : ''}" href="#${escape(item.id)}">${escape(item.text)}</a>`).join('')}</nav>` : '<p class="eyebrow">Built on Markdown</p><p class="outline-note">Plain text.<br>Lasting knowledge.</p>'}<a class="outline-guide" href="/guide">Working with the API →</a></aside></div>
  </body></html>`;
}

export function indexContent(pages, query) {
  return `<div class="breadcrumb">Library <span>/</span> ${query ? 'Search' : 'Overview'}</div><header class="article-header"><p class="eyebrow">The knowledge base</p><h1>${query ? 'Search results' : 'A little wiki.<br>A shared understanding.'}</h1><p class="lead">${query ? `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} matching “${escape(query)}”` : 'Notes, guides, and the things worth keeping. Written in Markdown. Ready to share.'}</p></header>
  <section class="page-list" aria-label="${query ? 'Search results' : 'All pages'}"><div class="list-heading"><h2>${query ? 'Matching pages' : 'Explore the pages'}</h2><span>${pages.length} ${pages.length === 1 ? 'page' : 'pages'}</span></div>${pages.length ? pages.map(page => `<a class="page-row" href="/wiki/${page.slug}"><div><h3>${escape(page.title)}</h3><p>${escape(page.summary)}</p><span class="page-slug">${page.slug}.md</span></div><span class="row-arrow" aria-hidden="true">↗</span></a>`).join('') : `<div class="empty"><h3>${query ? 'No pages found' : 'Your wiki starts here'}</h3><p>${query ? 'Try a different word, or return to the full library.' : 'Publish your first Markdown page using the API.'}</p><a href="${query ? '/' : '/guide'}">${query ? 'View all pages' : 'Create your first page'} →</a></div>`}</section><footer class="content-footer">Small by design. Useful by nature.<span>min wiki / 01</span></footer>`;
}

export function articleContent(page) {
  return `<div class="breadcrumb"><a href="/">Library</a><span>/</span>${escape(page.title)}</div><header class="article-header"><p class="eyebrow">Wiki page</p><h1 id="${escape(page.titleId)}">${escape(page.title)}</h1><div class="article-meta"><span>Updated <time datetime="${escape(page.updatedAt)}">${new Date(page.updatedAt).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })}</time></span><span aria-hidden="true">·</span><a href="/wiki/${page.slug}/source">View Markdown ↗</a></div></header><article class="prose">${page.html}</article><footer class="content-footer"><a href="/">← All pages</a><span>${page.slug}.md</span></footer>`;
}
