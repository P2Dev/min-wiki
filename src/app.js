import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Store, Problem, fail } from './store.js';
import { renderMarkdown, layout, indexContent, articleContent, escape, projectHome, pageUrl, editorContent, projectsContent, parentContent } from './render.js';
import { createAuth, can } from './auth.js';
import { readConfig } from './config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const describe = (page, project = 'default') => ({ ...page, project, url: pageUrl(project, page.slug), ...renderMarkdown(page.markdown, page.slug, project) });
const publicPage = page => ({ slug: page.slug, project: page.project, title: page.title, markdown: page.markdown, html: page.html, updatedAt: page.updatedAt, etag: page.etag, url: page.url });
const queryText = query => {
  if (query === undefined) return '';
  if (typeof query !== 'string' || query.length > 200) fail(400, 'invalid_query', 'Search must be a string of at most 200 characters.');
  return query.trim();
};
const bodyMarkdown = request => typeof request.body === 'string' ? request.body : request.body?.markdown;

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), onError = console.error, config = readConfig(), authDependencies } = {}) {
  const store = new Store(dataDir);
  await store.init();
  const auth = createAuth(store, config, authDependencies);
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.locals.store = store;
  app.use((request, response, next) => {
    response.set({
      // Cognito logout redirects a local POST to the configured provider origin.
      'Content-Security-Policy': `default-src 'none'; style-src 'self'; img-src 'self' https:; base-uri 'none'; form-action 'self'${config.cognito ? ` ${config.cognito.domain}` : ''}; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
    });
    next();
  });
  app.use('/assets', express.static(path.join(root, 'public'), { dotfiles: 'deny', index: false }));
  // Browsers request this independently. Redirecting it to sign-in would replace
  // the login transaction cookie while the user is completing their form.
  app.get('/favicon.ico', (request, response) => response.status(204).end());
  app.get('/health', (request, response) => response.json({ status: 'ok' }));
  auth.routes(app);
  app.use(async (request, response, next) => {
    const isApi = /^\/api(?:\/|$)/i.test(request.path);
    if (isApi) {
      request.identity = await auth.bearer(request);
      if (request.get('authorization') && !request.identity) return auth.requireRole('read')(request, response, next);
      if (config.visibility === 'private') return auth.requireRole('read')(request, response, next);
    } else {
      request.webSession = await auth.session(request);
      request.identity = request.webSession?.identity;
      if (config.visibility === 'private' && !request.identity) return response.redirect(303, `/auth/login?next=${encodeURIComponent(request.originalUrl)}`);
    }
    next();
  });
  app.use('/api', (request, response, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return auth.requireRole('write')(request, response, next);
    next();
  });
  app.use(express.json({ limit: '300kb' }));
  app.use(express.text({ type: ['text/markdown', 'text/plain'], limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '800kb' }));

  async function allPages(project = 'default') {
    const scoped = await store.forProject(project);
    const tree = await scoped.tree();
    return (await scoped.list()).map(page => describe({ ...page, parent: tree.parents[page.slug] ?? null }, project)).sort((a, b) => a.title.localeCompare(b.title));
  }
  async function readPage(scoped, slug, project) {
    const page = await scoped.get(slug);
    const tree = await scoped.tree();
    return describe({ ...page, parent: tree.parents[slug] ?? null }, project);
  }
  const filterPages = (pages, query) => pages.filter(page => `${page.title}\n${page.markdown}`.toLowerCase().includes(query.toLowerCase()));
  const apiPages = express.Router({ mergeParams: true });
  apiPages.use(async (request, response, next) => {
    request.projectSlug = request.params.project || 'default';
    request.pageStore = await store.forProject(request.projectSlug);
    next();
  });
  apiPages.get('/', async (request, response) => {
    const pages = filterPages(await allPages(request.projectSlug), queryText(request.query.q));
    response.json({ pages: pages.map(({ slug, project, parent, title, summary, updatedAt, etag, url }) => ({ slug, project, parent, title, summary, updatedAt, etag, url })), total: pages.length });
  });
  apiPages.get('/:slug/parent', async (request, response) => {
    await request.pageStore.get(request.params.slug);
    const tree = await request.pageStore.tree();
    response.set('ETag', tree.etag).json({ slug: request.params.slug, parent: tree.parents[request.params.slug], etag: tree.etag });
  });
  apiPages.put('/:slug/parent', async (request, response) => {
    const tree = await request.pageStore.changeParent(request.params.slug, request.body?.parent, request.get('if-match'));
    response.set('ETag', tree.etag).json({ slug: request.params.slug, parent: tree.parents[request.params.slug], etag: tree.etag });
  });
  apiPages.get('/:slug/raw', async (request, response) => {
    const page = await request.pageStore.get(request.params.slug);
    response.set('ETag', page.etag).type('text/markdown').send(page.markdown);
  });
  apiPages.get('/:slug', async (request, response) => {
    const page = await readPage(request.pageStore, request.params.slug, request.projectSlug);
    response.set('ETag', page.etag).json(publicPage(page));
  });
  apiPages.post('/', async (request, response) => {
    const saved = await request.pageStore.create(request.body?.slug, request.body?.markdown, request.body?.parent);
    const page = await readPage(request.pageStore, saved.slug, request.projectSlug);
    response.status(201).location(`${request.baseUrl}/${page.slug}`).set('ETag', page.etag).json(publicPage(page));
  });
  apiPages.put('/:slug', async (request, response) => {
    const creating = request.get('if-none-match') === '*';
    if (creating && request.get('if-match')) fail(400, 'conflicting_conditions', 'Use either If-Match or If-None-Match, not both.');
    if (!creating && request.body && typeof request.body === 'object' && Object.hasOwn(request.body, 'parent')) fail(400, 'separate_parent_update', 'Change the parent through this page’s /parent endpoint using its hierarchy ETag.');
    let saved;
    try {
      saved = creating ? await request.pageStore.create(request.params.slug, bodyMarkdown(request), typeof request.body === 'object' ? request.body?.parent : null) : await request.pageStore.change(request.params.slug, bodyMarkdown(request), request.get('if-match'));
    } catch (error) {
      if (creating && error.code === 'page_exists') fail(412, 'page_exists', 'This page already exists. Fetch its ETag and use If-Match to update it.');
      throw error;
    }
    const page = await readPage(request.pageStore, saved.slug, request.projectSlug);
    response.status(creating ? 201 : 200).location(`${request.baseUrl}/${page.slug}`).set('ETag', page.etag).json(publicPage(page));
  });
  apiPages.delete('/:slug', async (request, response) => {
    await request.pageStore.change(request.params.slug, null, request.get('if-match'), true);
    response.status(204).end();
  });
  app.get('/api/me', auth.requireRole('read'), (request, response) => response.json({ identity: request.identity }));
  app.get('/api/projects', async (request, response) => response.json({ projects: await store.projects() }));
  app.get('/api/projects/:project', async (request, response) => response.json(await store.project(request.params.project)));
  app.post('/api/projects', auth.requireRole('admin'), async (request, response) => {
    const project = await store.createProject(request.body?.slug, request.body?.name, request.body?.description);
    response.status(201).location(`/api/projects/${project.slug}`).json(project);
  });
  app.delete('/api/projects/:project', auth.requireRole('admin'), async (request, response) => { await store.deleteProject(request.params.project); response.status(204).end(); });
  app.use('/api/projects/:project/pages', apiPages);
  app.use('/api/pages', apiPages);
  app.use('/api/keys', auth.requireRole('admin'));
  app.get('/api/keys', async (request, response) => response.json({ keys: (await store.keys()).map(({ hash, ...key }) => key) }));
  app.post('/api/keys', async (request, response) => response.status(201).json(await store.issueKey(request.body?.name, request.body?.role || 'write')));
  app.delete('/api/keys/:id', async (request, response) => { await store.revokeKey(request.params.id); response.status(204).end(); });
  app.use('/api', () => fail(404, 'endpoint_not_found', 'Unknown API endpoint. See /guide for the available routes.'));

  async function show(request, response, view, project = 'default') {
    const projectInfo = await store.project(project);
    response.type('html').send(layout({ pages: await allPages(project), projects: await store.projects(), project: projectInfo, identity: request.identity, csrf: request.webSession?.csrf, visibility: config.visibility, ...view }));
  }
  async function index(request, response) {
    const project = request.params.project || 'default';
    const info = await store.project(project);
    const query = queryText(request.query.q);
    await show(request, response, { title: query ? 'Search results' : info.name, active: 'index', query, content: indexContent(filterPages(await allPages(project), query), query, info) }, project);
  }
  app.get('/', index);
  app.get('/projects/:project', index);
  app.get('/projects', async (request, response) => show(request, response, { title: 'Projects', content: projectsContent(await store.projects()) }));
  app.get('/guide', async (request, response) => {
    const guide = renderMarkdown(await readFile(path.join(root, 'docs/api.md'), 'utf8'), 'api-guide');
    await show(request, response, { title: 'API guide', outline: guide.outline, content: `<div class="breadcrumb"><a href="/">Library</a><span>/</span>API guide</div><header class="article-header"><p class="eyebrow">For builders</p><h1 id="${escape(guide.titleId)}">${escape(guide.title)}</h1><p class="lead">Your wiki, from any script or tool.</p></header><article class="prose">${guide.html}</article>` });
  });
  const reader = express.Router({ mergeParams: true });
  reader.use(async (request, response, next) => {
    request.projectSlug = request.params.project || 'default';
    request.pageStore = await store.forProject(request.projectSlug);
    next();
  });
  reader.get('/:slug', async (request, response) => {
    const page = await readPage(request.pageStore, request.params.slug, request.projectSlug);
    await show(request, response, { title: page.title, active: page.slug, outline: page.outline, content: articleContent(page, can(request.identity, 'write'), await allPages(request.projectSlug)) }, request.projectSlug);
  });
  reader.get('/:slug/source', async (request, response) => {
    const page = await readPage(request.pageStore, request.params.slug, request.projectSlug);
    await show(request, response, { title: `${page.title} — Markdown`, active: page.slug, content: `<div class="breadcrumb"><a href="${page.url}">${escape(page.title)}</a><span>/</span>Markdown source</div><header class="article-header"><p class="eyebrow">Page source</p><h1>${escape(page.title)}</h1><p class="lead">${page.slug}.md</p><a class="button-link" href="${page.url}">← Back to the page</a></header><div class="prose"><pre tabindex="0" aria-label="Markdown source"><code>${escape(page.markdown)}</code></pre></div>` }, request.projectSlug);
  });
  async function showParent(request, response, error = '') {
    const page = await readPage(request.pageStore, request.params.slug, request.projectSlug);
    const tree = await request.pageStore.tree();
    await show(request, response, { title: `Move ${page.title}`, active: page.slug, content: parentContent({ page, pages: await allPages(request.projectSlug), treeEtag: tree.etag, csrf: request.webSession.csrf, error }) }, request.projectSlug);
  }
  reader.get('/:slug/parent', auth.requireRole('write'), (request, response) => showParent(request, response));
  reader.post('/:slug/parent', auth.requireRole('write'), async (request, response) => {
    auth.csrf(request);
    try {
      await request.pageStore.changeParent(request.params.slug, request.body?.parent === '' ? null : request.body?.parent, request.body?.etag);
      response.redirect(303, pageUrl(request.projectSlug, request.params.slug));
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      response.status(error.status);
      await showParent(request, response, error.message);
    }
  });
  reader.get('/:slug/edit', auth.requireRole('write'), async (request, response) => {
    const page = await readPage(request.pageStore, request.params.slug, request.projectSlug);
    await show(request, response, { title: `Edit ${page.title}`, active: page.slug, content: editorContent({ page, project: request.projectSlug, csrf: request.webSession.csrf }) }, request.projectSlug);
  });
  reader.post('/:slug/edit', auth.requireRole('write'), async (request, response) => {
    auth.csrf(request);
    try {
      await request.pageStore.change(request.params.slug, request.body?.markdown, request.body?.etag);
      response.redirect(303, pageUrl(request.projectSlug, request.params.slug));
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      response.status(error.status);
      await show(request, response, { title: 'Review your edit', content: editorContent({ page: { slug: request.params.slug, markdown: typeof request.body?.markdown === 'string' ? request.body.markdown : '', etag: request.body?.etag, title: request.params.slug }, project: request.projectSlug, csrf: request.webSession.csrf, error: error.message }) }, request.projectSlug);
    }
  });
  app.use('/wiki', reader);
  app.use('/projects/:project/wiki', reader);
  app.get('/projects/:project/new', auth.requireRole('write'), async (request, response) => show(request, response, { title: 'New page', content: editorContent({ project: request.params.project, csrf: request.webSession.csrf, pages: await allPages(request.params.project), draft: { parent: request.query.parent } }) }, request.params.project));
  app.post('/projects/:project/new', auth.requireRole('write'), async (request, response) => {
    auth.csrf(request);
    const scoped = await store.forProject(request.params.project);
    try {
      const page = await scoped.create(request.body?.slug, request.body?.markdown, request.body?.parent === '' ? null : request.body?.parent);
      response.redirect(303, pageUrl(request.params.project, page.slug));
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      response.status(error.status);
      await show(request, response, { title: 'Review your page', content: editorContent({ project: request.params.project, csrf: request.webSession.csrf, draft: request.body, pages: await allPages(request.params.project), error: error.message }) }, request.params.project);
    }
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
    if (/^\/api(?:\/|$)/i.test(request.path)) return response.json({ error: { code: problem.code, message: problem.message } });
    response.type('html').send(layout({ title: problem.status === 404 ? 'Page not found' : 'Request could not be completed', pages: [], visibility: config.visibility, content: `<div class="breadcrumb"><a href="/">Library</a><span>/</span>${problem.status}</div><header class="article-header"><p class="eyebrow">${problem.status}</p><h1>${problem.status === 404 ? 'This page is missing.' : 'Request could not be completed.'}</h1><p class="lead">${escape(problem.message)}</p><a class="button-link" href="/auth/login">Sign in →</a><br><a class="button-link" href="/">Return to the wiki →</a></header>` }));
  });
  return app;
}
