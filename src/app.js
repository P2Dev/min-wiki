import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Store, Problem, fail } from './store.js';
import { renderMarkdown, layout, indexContent, articleContent, escape } from './render.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const describe = page => ({ ...page, ...renderMarkdown(page.markdown, page.slug) });
const publicPage = page => ({ slug: page.slug, title: page.title, markdown: page.markdown, html: page.html, updatedAt: page.updatedAt, etag: page.etag, url: `/wiki/${page.slug}` });
const queryText = query => {
  if (query === undefined) return '';
  if (typeof query !== 'string' || query.length > 200) fail(400, 'invalid_query', 'Search must be a string of at most 200 characters.');
  return query.trim();
};
const bodyMarkdown = request => typeof request.body === 'string' ? request.body : request.body?.markdown;

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), onError = console.error } = {}) {
  const store = new Store(dataDir);
  await store.init();
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.locals.store = store;
  app.use((request, response, next) => {
    response.set({
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self' https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use('/assets', express.static(path.join(root, 'public'), { dotfiles: 'deny', index: false }));

  const authorize = role => async (request, response, next) => {
    const match = /^Bearer (\S+)$/i.exec(request.get('authorization') || '');
    const key = match ? await store.authenticate(match[1]) : null;
    if (!key) { response.set('WWW-Authenticate', 'Bearer realm="min-wiki"'); fail(401, 'unauthorized', 'Provide a valid access key using Authorization: Bearer <key>.'); }
    if (role === 'admin' && key.role !== 'admin') fail(403, 'forbidden', 'An admin key is required for key management.');
    next();
  };
  app.use('/api', (request, response, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return authorize('write')(request, response, next).catch(next);
    next();
  });
  app.use(express.json({ limit: '300kb' }));
  app.use(express.text({ type: ['text/markdown', 'text/plain'], limit: '256kb' }));

  async function allPages() {
    return (await store.list()).map(describe).sort((a, b) => a.title.localeCompare(b.title));
  }
  const filterPages = (pages, query) => pages.filter(page => `${page.title}\n${page.markdown}`.toLowerCase().includes(query.toLowerCase()));

  app.get('/health', (request, response) => response.json({ status: 'ok' }));
  app.get('/api/pages', async (request, response) => {
    const query = queryText(request.query.q);
    const pages = filterPages(await allPages(), query);
    response.json({ pages: pages.map(({ slug, title, summary, updatedAt, etag }) => ({ slug, title, summary, updatedAt, etag, url: `/wiki/${slug}` })), total: pages.length });
  });
  app.get('/api/pages/:slug/raw', async (request, response) => {
    const page = await store.get(request.params.slug);
    response.set('ETag', page.etag).type('text/markdown').send(page.markdown);
  });
  app.get('/api/pages/:slug', async (request, response) => {
    const page = describe(await store.get(request.params.slug));
    response.set('ETag', page.etag).json(publicPage(page));
  });
  app.post('/api/pages', async (request, response) => {
    const page = describe(await store.create(request.body?.slug, request.body?.markdown));
    response.status(201).location(`/api/pages/${page.slug}`).set('ETag', page.etag).json(publicPage(page));
  });
  // PUT creates only with If-None-Match: *, or updates with the exact current ETag.
  app.put('/api/pages/:slug', async (request, response) => {
    const creating = request.get('if-none-match') === '*';
    if (creating && request.get('if-match')) fail(400, 'conflicting_conditions', 'Use either If-Match or If-None-Match, not both.');
    let saved;
    try {
      saved = creating
        ? await store.create(request.params.slug, bodyMarkdown(request))
        : await store.change(request.params.slug, bodyMarkdown(request), request.get('if-match'));
    } catch (error) {
      if (creating && error.code === 'page_exists') fail(412, 'page_exists', 'This page already exists. Fetch its ETag and use If-Match to update it.');
      throw error;
    }
    const page = describe(saved);
    response.status(creating ? 201 : 200).location(`/api/pages/${page.slug}`).set('ETag', page.etag).json(publicPage(page));
  });
  app.delete('/api/pages/:slug', async (request, response) => {
    await store.change(request.params.slug, null, request.get('if-match'), true);
    response.status(204).end();
  });

  app.use('/api/keys', authorize('admin'));
  app.get('/api/keys', async (request, response) => response.json({ keys: (await store.keys()).map(({ hash, ...key }) => key) }));
  app.post('/api/keys', async (request, response) => response.status(201).json(await store.issueKey(request.body?.name, request.body?.role || 'write')));
  app.delete('/api/keys/:id', async (request, response) => { await store.revokeKey(request.params.id); response.status(204).end(); });
  app.use('/api', () => fail(404, 'endpoint_not_found', 'Unknown API endpoint. See /guide for the available routes.'));

  app.get('/', async (request, response) => {
    const pages = await allPages();
    const query = queryText(request.query.q);
    response.type('html').send(layout({ title: query ? 'Search results' : 'Library', pages, active: 'index', query, content: indexContent(filterPages(pages, query), query) }));
  });
  app.get('/guide', async (request, response) => {
    const guide = renderMarkdown(await readFile(path.join(root, 'docs/api.md'), 'utf8'), 'api-guide');
    response.type('html').send(layout({ title: 'API guide', pages: await allPages(), outline: guide.outline, content: `<div class="breadcrumb"><a href="/">Library</a><span>/</span>API guide</div><header class="article-header"><p class="eyebrow">For builders</p><h1 id="${escape(guide.titleId)}">${escape(guide.title)}</h1><p class="lead">Your wiki, from any script or tool.</p></header><article class="prose">${guide.html}</article>` }));
  });
  app.get('/wiki/:slug', async (request, response) => {
    const page = describe(await store.get(request.params.slug));
    response.type('html').send(layout({ title: page.title, pages: await allPages(), active: page.slug, outline: page.outline, content: articleContent(page) }));
  });
  app.get('/wiki/:slug/source', async (request, response) => {
    const page = describe(await store.get(request.params.slug));
    response.type('html').send(layout({ title: `${page.title} — Markdown`, pages: await allPages(), active: page.slug, content: `<div class="breadcrumb"><a href="/wiki/${page.slug}">${escape(page.title)}</a><span>/</span>Markdown source</div><header class="article-header"><p class="eyebrow">Page source</p><h1>${escape(page.title)}</h1><p class="lead">${page.slug}.md</p><a class="button-link" href="/wiki/${page.slug}">← Back to the page</a></header><div class="prose"><pre tabindex="0" aria-label="Markdown source"><code>${escape(page.markdown)}</code></pre></div>` }));
  });
  app.use(() => fail(404, 'not_found', 'This page does not exist. It may have been moved or deleted.'));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    let problem = error;
    if (error.type === 'entity.too.large') problem = new Problem(413, 'too_large', 'Request body is too large. Pages are limited to 256 KiB.');
    else if (error.type === 'entity.parse.failed') problem = new Problem(400, 'invalid_json', 'Request body must contain valid JSON.');
    else if (error instanceof URIError) problem = new Problem(400, 'invalid_path', 'The URL is not valid.');
    else if (!(error instanceof Problem)) { onError(error); problem = new Problem(500, 'internal_error', 'The request could not be completed. Please try again.'); }
    response.status(problem.status);
    if (request.path.startsWith('/api/') || request.path === '/api') return response.json({ error: { code: problem.code, message: problem.message } });
    response.type('html').send(layout({ title: problem.status === 404 ? 'Page not found' : 'Something went wrong', pages: [], content: `<div class="breadcrumb"><a href="/">Library</a><span>/</span>${problem.status}</div><header class="article-header"><p class="eyebrow">${problem.status}</p><h1>${problem.status === 404 ? 'This page is missing.' : 'Something went wrong.'}</h1><p class="lead">${escape(problem.message)}</p><a class="button-link" href="/">Return to all pages →</a></header>` }));
  });
  return app;
}
