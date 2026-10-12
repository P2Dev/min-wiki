import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { createCognitoVerifier, localReturn } from '../src/auth.js';
import { Store } from '../src/store.js';

const pool = 'us-east-1_TestPool';
const clientId = 'testclient123';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const issuer = `https://cognito-idp.us-east-1.amazonaws.com/${pool}`;
function jwt(changes = {}, key = pair.privateKey) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = { iss: issuer, client_id: clientId, sub: 'user-1', username: 'Writer One', token_use: 'access', exp: Math.floor(Date.now() / 1000) + 3600, ...changes };
  const body = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(payload)}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}
const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
const responseCookie = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(';')[0];

async function fixture(t, { cognito = false, visibility = 'private', publicUrl = 'http://127.0.0.1:3000', dependencies = {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'min-wiki-access-'));
  const config = readConfig({ WIKI_VISIBILITY: visibility, PUBLIC_URL: publicUrl, ...(cognito ? { COGNITO_USER_POOL_ID: pool, COGNITO_CLIENT_ID: clientId, COGNITO_DOMAIN: 'https://test.auth.us-east-1.amazoncognito.com', COGNITO_ADMIN_GROUP: 'wiki-admins' } : {}) });
  const verifier = cognito ? createCognitoVerifier(config.cognito) : null;
  verifier?.cacheJwks({ keys: [jwk] });
  const errors = [];
  const app = await createApp({ dataDir: directory, config, authDependencies: { verifier, ...dependencies }, onError: error => errors.push(error) });
  const store = app.locals.store;
  const admin = await store.issueKey('Administrator', 'admin');
  const writer = await store.issueKey('Writer', 'write');
  const reader = await store.issueKey('Reader', 'read');
  await store.create('hidden', '# Confidential title\n\nPrivate needle.');
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, { key, cookie, json, form, ...options } = {}) {
    const response = await fetch(base + url, { redirect: 'manual', ...options, headers: { ...(key ? { authorization: `Bearer ${key.secret || key}` } : {}), ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...options.headers }, ...(json !== undefined ? { body: JSON.stringify(json) } : form ? { body: new URLSearchParams(form).toString() } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : undefined };
  }
  async function login(key = writer, next = '/') {
    const page = await request(`/auth/login?next=${encodeURIComponent(next)}`);
    const response = await request('/auth/key', { method: 'POST', cookie: responseCookie(page, 'mw_flow'), form: { csrf: field(page.text, 'csrf'), key: key.secret } });
    assert.equal(response.status, 303);
    return { response, cookie: responseCookie(response, 'mw_session') };
  }
  return { directory, request, login, store, config, admin, writer, reader };
}

test('private mode closes every content route, including metadata and aliases', async t => {
  const { request } = await fixture(t);
  for (const url of ['/', '/?q=needle', '/wiki/hidden', '/wiki/hidden/source', '/wiki/hidden/edit', '/guide', '/projects', '/projects/default', '/projects/default/wiki/hidden']) {
    const result = await request(url);
    assert.equal(result.status, 303, url); assert.match(result.headers.get('location'), /^\/auth\/login/);
    assert.ok(!result.text.includes('Confidential title'));
  }
  for (const url of ['/api/pages', '/api/pages?q=needle', '/api/pages/hidden', '/api/pages/hidden/raw', '/api/projects', '/api/projects/default', '/api/projects/default/pages/hidden', '/API/pages']) {
    assert.equal((await request(url)).status, 401, url);
    assert.equal((await request(url, { method: 'HEAD' })).status, 401, url);
  }
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/assets/style.css')).status, 200);
  const icon = await request('/favicon.ico');
  assert.equal(icon.status, 204); assert.equal(icon.headers.get('set-cookie'), null);
  const login = await request('/auth/login'); assert.equal(login.status, 200); assert.ok(!login.text.includes('Confidential title'));
  assert.equal(login.headers.get('referrer-policy'), 'same-origin');
});

test('read keys read every project, cannot write or administer, and invalid credentials do not fall back', async t => {
  const { request, reader, writer } = await fixture(t);
  assert.equal((await request('/api/pages/hidden', { key: reader })).status, 200);
  assert.equal((await request('/api/projects', { key: reader })).status, 200);
  assert.equal((await request('/api/pages', { method: 'POST', key: reader, json: { slug: 'denied', markdown: '# No' } })).status, 403);
  assert.equal((await request('/api/projects', { method: 'POST', key: writer, json: { slug: 'denied', name: 'No' } })).status, 403);
  assert.equal((await request('/api/keys', { key: reader })).status, 403);
  assert.equal((await request('/api/pages', { key: 'invalid' })).status, 401);
});

test('key browser sessions bind CSRF, preserve destination, expire and revoke immediately', async t => {
  let time = Date.now();
  const { request, login, writer, store } = await fixture(t, { dependencies: { now: () => time } });
  const signedIn = await login(writer, '/wiki/hidden');
  assert.equal(signedIn.response.headers.get('location'), '/wiki/hidden');
  assert.match(signedIn.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(signedIn.response.headers.get('set-cookie'), /SameSite=Lax/);
  const page = await request('/wiki/hidden', { cookie: signedIn.cookie });
  assert.equal(page.status, 200); assert.match(page.text, /Edit page/);
  assert.equal((await request('/api/pages', { cookie: signedIn.cookie })).status, 401);
  assert.equal((await request('/auth/logout', { method: 'POST', cookie: signedIn.cookie, form: { csrf: 'wrong' } })).status, 403);
  assert.equal((await request('/auth/logout', { method: 'POST', cookie: signedIn.cookie, form: { csrf: field(page.text, 'csrf') } })).status, 303);
  assert.equal((await request('/', { cookie: signedIn.cookie })).status, 303);
  const second = await login(); time += 3_600_001;
  assert.equal((await request('/', { cookie: second.cookie })).status, 303);
  time = Date.now(); const third = await login(); await store.revokeKey(writer.id);
  assert.equal((await request('/', { cookie: third.cookie })).status, 303);
});

test('editor saves Markdown, requires role and CSRF, and retains drafts on conflict', async t => {
  const { request, login, reader, store } = await fixture(t);
  const readerSession = await login(reader);
  assert.equal((await request('/wiki/hidden/edit', { cookie: readerSession.cookie })).status, 403);
  const { cookie } = await login();
  const editor = await request('/wiki/hidden/edit', { cookie });
  const form = { csrf: field(editor.text, 'csrf'), etag: field(editor.text, 'etag'), markdown: '# Edited\n\nNew content.' };
  assert.equal((await request('/wiki/hidden/edit', { method: 'POST', cookie, form: { ...form, csrf: '' } })).status, 403);
  assert.equal((await request('/wiki/hidden/edit', { method: 'POST', cookie, form, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/wiki/hidden/edit', { method: 'POST', cookie, form })).status, 303);
  const conflict = await request('/wiki/hidden/edit', { method: 'POST', cookie, form: { ...form, markdown: '# My retained draft' } });
  assert.equal(conflict.status, 412); assert.match(conflict.text, /My retained draft/);
  assert.equal((await store.get('hidden')).markdown, form.markdown);
  const create = await request('/projects/default/new', { cookie });
  assert.equal((await request('/projects/default/new', { method: 'POST', cookie, form: { csrf: field(create.text, 'csrf'), slug: 'from-browser', markdown: '# Published' } })).status, 303);
  assert.equal((await store.get('from-browser')).markdown, '# Published');
});

test('Cognito signature, issuer, client, type, expiry, and group roles are enforced', async t => {
  const { request } = await fixture(t, { cognito: true });
  assert.equal((await request('/api/me', { key: jwt() })).data.identity.role, 'write');
  assert.equal((await request('/api/pages', { method: 'POST', key: jwt(), json: { slug: 'cognito-edit', markdown: '# Every user can edit' } })).status, 201);
  assert.equal((await request('/api/keys', { key: jwt() })).status, 403);
  assert.equal((await request('/api/keys', { key: jwt({ 'cognito:groups': ['wiki-admins'] }) })).status, 200);
  assert.equal((await request('/api/keys', { key: jwt({ scope: 'aws.cognito.signin.user.admin' }) })).status, 403);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const token of [jwt({ iss: 'https://wrong.example' }), jwt({ client_id: 'wrong' }), jwt({ token_use: 'id', aud: clientId }), jwt({ exp: 1 }), jwt({ username: undefined }), jwt({}, other.privateKey)]) {
    assert.equal((await request('/api/pages', { key: token })).status, 401);
  }
});

test('Cognito authorization code uses PKCE and state; callback is single-use and logout clears session', async t => {
  let exchange;
  const { request } = await fixture(t, { cognito: true, dependencies: { fetchToken: async (url, options) => { exchange = { url, options }; return new Response(JSON.stringify({ access_token: jwt() }), { headers: { 'content-type': 'application/json' } }); } } });
  const begin = await request('/auth/cognito?next=/wiki/hidden');
  const authorization = new URL(begin.headers.get('location'));
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  const flowCookie = responseCookie(begin, 'mw_flow');
  const callback = '/auth/callback?code=test-code&state=' + authorization.searchParams.get('state');
  const finish = await request(callback, { cookie: flowCookie });
  assert.equal(finish.status, 303); assert.equal(finish.headers.get('location'), '/wiki/hidden');
  const body = new URLSearchParams(exchange.options.body);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
  assert.equal((await request(callback, { cookie: flowCookie })).status, 400);
  const cookie = responseCookie(finish, 'mw_session');
  const page = await request('/wiki/hidden', { cookie }); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /form-action 'self' https:\/\/test\.auth\.us-east-1\.amazoncognito\.com;/);
  assert.ok(!page.text.includes(jwt()));
  const logout = await request('/auth/logout', { method: 'POST', cookie, form: { csrf: field(page.text, 'csrf') } });
  const destination = new URL(logout.headers.get('location'));
  assert.equal(destination.pathname, '/logout'); assert.equal(destination.searchParams.get('logout_uri'), 'http://127.0.0.1:3000/auth/login');
  assert.equal((await request('/', { cookie })).status, 303);
});

test('HTTPS sessions use secure host cookies and expire with their Cognito token', async t => {
  let time = Date.now();
  const expires = Math.floor(time / 1000) + 30;
  const { request } = await fixture(t, { cognito: true, publicUrl: 'https://wiki.example', dependencies: { now: () => time, fetchToken: async () => new Response(JSON.stringify({ access_token: jwt({ exp: expires }) })) } });
  const begin = await request('/auth/cognito');
  const cookieHeader = begin.headers.get('set-cookie');
  assert.match(cookieHeader, /__Host-mw_flow=/); assert.match(cookieHeader, /; Secure/); assert.match(cookieHeader, /; HttpOnly/); assert.ok(!cookieHeader.includes('Domain='));
  const state = new URL(begin.headers.get('location')).searchParams.get('state');
  const finish = await request(`/auth/callback?code=test&state=${state}`, { cookie: responseCookie(begin, '__Host-mw_flow') });
  assert.equal(finish.status, 303);
  assert.match(finish.headers.get('set-cookie'), /__Host-mw_session=/);
  assert.match(finish.headers.get('set-cookie'), /; Secure/);
  const cookie = responseCookie(finish, '__Host-mw_session');
  assert.equal((await request('/', { cookie })).status, 200);
  time = expires * 1000 + 1;
  assert.equal((await request('/', { cookie })).status, 303);
});

test('OAuth state mismatch, provider denial and network failure cannot create sessions', async t => {
  let calls = 0;
  const { request } = await fixture(t, { cognito: true, dependencies: { fetchToken: async () => { calls++; throw new Error('Do not expose client secrets'); } } });
  for (const mode of ['wrong-state', 'denial', 'network']) {
    const begin = await request('/auth/cognito?next=https://evil.example');
    const state = new URL(begin.headers.get('location')).searchParams.get('state');
    const cookie = responseCookie(begin, 'mw_flow');
    const callback = mode === 'denial' ? `/auth/callback?error=access_denied&state=${state}` : `/auth/callback?code=code&state=${mode === 'wrong-state' ? 'wrong' : state}`;
    const response = await request(callback, { cookie });
    assert.equal(response.status, mode === 'network' ? 503 : 400);
    assert.ok(!responseCookie(response, 'mw_session')); assert.ok(!response.text.includes('Do not expose client secrets'));
  }
  assert.equal(calls, 1);
});

test('project namespaces isolate slugs, search and links, preserving legacy paths and persistence', async t => {
  const { request, admin, writer, reader, directory, store } = await fixture(t);
  const project = await request('/api/projects', { method: 'POST', key: admin, json: { slug: 'engineering', name: 'Engineering', description: 'Build notes' } });
  assert.equal(project.status, 201);
  const markdown = '# Engineering only\n\nBuild needle.\n\n[Another](other.md#details)';
  assert.equal((await request('/api/projects/engineering/pages', { method: 'POST', key: writer, json: { slug: 'hidden', markdown } })).status, 201);
  assert.equal((await request('/api/pages/hidden', { key: reader })).data.title, 'Confidential title');
  const scoped = await request('/api/projects/engineering/pages/hidden', { key: reader });
  assert.equal(scoped.data.url, '/projects/engineering/wiki/hidden'); assert.match(scoped.data.html, /href="\/projects\/engineering\/wiki\/other#details"/);
  assert.equal((await request('/api/projects/engineering/pages?q=Private', { key: reader })).data.total, 0);
  assert.equal((await request('/api/projects/default/pages/hidden', { key: reader })).data.title, 'Confidential title');
  assert.equal(await readFile(path.join(directory, 'projects/engineering/hidden.md'), 'utf8'), markdown);
  const reopened = new Store(directory); await reopened.init(); assert.equal((await reopened.projects()).length, 2);
  assert.equal((await request('/api/projects/engineering', { method: 'DELETE', key: admin })).data.error.code, 'project_not_empty');
  await (await store.forProject('engineering')).change('hidden', null, scoped.data.etag, true);
  assert.equal((await request('/api/projects/engineering', { method: 'DELETE', key: admin })).status, 204);
  assert.equal((await request('/api/projects/default', { method: 'DELETE', key: admin })).status, 409);
  assert.equal((await request('/api/projects/engineering/pages', { key: reader })).status, 404);
});

test('project paths reject traversal, symlinks, duplicates and concurrent creation', async t => {
  const { request, admin, directory } = await fixture(t);
  for (const slug of ['../escape', 'bad/name', 'UPPER']) assert.equal((await request('/api/projects', { method: 'POST', key: admin, json: { slug, name: 'No' } })).status, 400);
  await symlink(directory, path.join(directory, 'projects/linked'));
  assert.equal((await request('/api/projects', { method: 'POST', key: admin, json: { slug: 'linked', name: 'No' } })).status, 409);
  const results = await Promise.all([1, 2].map(() => request('/api/projects', { method: 'POST', key: admin, json: { slug: 'race', name: 'Race' } })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
});

test('configuration fails closed and return destinations cannot escape the wiki', () => {
  assert.throws(() => readConfig({ WIKI_VISIBILITY: 'privte' }), /WIKI_VISIBILITY/);
  assert.throws(() => readConfig({ COGNITO_CLIENT_ID: 'partial' }), /Cognito requires/);
  assert.throws(() => readConfig({ PUBLIC_URL: 'http://wiki.example' }), /HTTPS/);
  for (const value of ['//evil.example', '/\\evil.example', '/%2fevil.example', '/%5cevil.example', '/auth/cognito', 'https://evil.example', '/%ZZ']) assert.equal(localReturn(value), '/');
  assert.equal(localReturn('/projects/engineering?q=test'), '/projects/engineering?q=test');
});

test('subpages persist separately from Markdown and keep URLs, links and content ETags stable', async t => {
  const { request, writer, store, directory } = await fixture(t);
  const markdown = '# Child\n\n[Parent](hidden.md)';
  const child = await request('/api/pages', { method: 'POST', key: writer, json: { slug: 'child', markdown, parent: 'hidden' } });
  assert.equal(child.status, 201); assert.equal(child.data.url, '/wiki/child');
  assert.equal(await readFile(path.join(directory, 'pages/child.md'), 'utf8'), markdown);
  assert.equal((await new Store(directory).tree()).parents.child, 'hidden');
  const get = await request('/api/pages/child', { key: writer }); assert.equal((await request('/api/pages/child/parent', { key: writer })).data.parent, 'hidden');
  assert.match(get.data.html, /href="\/wiki\/hidden"/);
  assert.equal((await request('/api/pages/child/raw', { key: writer })).text, markdown);
  const listing = await request('/api/pages?q=Child', { key: writer }); assert.equal(listing.data.pages[0].parent, 'hidden');
  const before = await request('/api/pages/child/parent', { key: writer });
  const moved = await request('/api/pages/child/parent', { method: 'PUT', key: writer, json: { parent: null }, headers: { 'if-match': before.headers.get('etag') } });
  assert.equal(moved.status, 200); assert.equal(moved.data.parent, null);
  assert.equal((await store.get('child')).etag, child.data.etag);
  const edit = await request('/api/pages/child', { method: 'PUT', key: writer, json: { markdown: '# Edited child' }, headers: { 'if-match': child.data.etag } });
  assert.equal(edit.status, 200); assert.equal((await request('/api/pages/child/parent', { key: writer })).data.parent, null);
  assert.equal((await store.tree()).etag, moved.headers.get('etag'));
});

test('tree writes reject cycles, stale edits, nonexistent parents, traversal and excessive nesting', async t => {
  const { request, writer, store } = await fixture(t);
  await store.create('child', '# Child', 'hidden'); await store.create('grandchild', '# Grandchild', 'child');
  const move = async (slug, parent, etag) => request(`/api/pages/${slug}/parent`, { method: 'PUT', key: writer, json: { parent }, headers: { 'if-match': etag ?? (await store.tree()).etag } });
  assert.equal((await move('hidden', 'grandchild')).data.error.code, 'parent_cycle');
  assert.equal((await move('child', 'child')).data.error.code, 'parent_cycle');
  assert.equal((await move('child', 'missing')).status, 404);
  assert.equal((await move('child', '../hidden')).status, 400);
  assert.equal((await move('child', '')).status, 400);
  assert.equal((await request('/api/pages/child/parent', { method: 'PUT', key: writer, json: { parent: null } })).status, 428);
  const etag = (await store.tree()).etag;
  const concurrent = await Promise.all([move('child', null, etag), move('grandchild', 'hidden', etag)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 412]);
  for (let level = 1; level <= 15; level++) await store.create(`level-${level}`, `# Level ${level}`, level === 1 ? 'hidden' : `level-${level - 1}`);
  assert.equal((await request('/api/pages', { method: 'POST', key: writer, json: { slug: 'too-deep', markdown: '# Too deep', parent: 'level-15' } })).data.error.code, 'tree_depth');
  await assert.rejects(store.get('too-deep'), error => error.status === 404);
});

test('parent deletion protects descendants, reusing a slug does not revive old relationships, projects remain isolated', async t => {
  const { request, writer, store, admin } = await fixture(t);
  const root = await store.get('hidden');
  const child = await store.create('child', '# Child', 'hidden');
  assert.equal((await request('/api/pages/hidden', { method: 'DELETE', key: writer, headers: { 'if-match': root.etag } })).data.error.code, 'page_has_children');
  await store.change('child', null, child.etag, true);
  await store.create('child', '# Reused'); assert.equal((await store.tree()).parents.child, null);
  await store.createProject('engineering', 'Engineering'); const other = await store.forProject('engineering');
  const prefix = '/api/projects/engineering/pages';
  assert.equal((await request(prefix, { method: 'POST', key: writer, json: { slug: 'child', markdown: '# Child', parent: 'hidden' } })).status, 404);
  await other.create('hidden', '# Different parent'); await other.create('child', '# Other child', 'hidden');
  assert.equal((await request(`${prefix}/child/parent`, { key: writer })).data.parent, 'hidden');
  assert.equal((await request('/api/pages/child/parent', { key: writer })).data.parent, null);
  await other.change('child', null, (await other.get('child')).etag, true);
  await other.change('hidden', null, (await other.get('hidden')).etag, true);
  assert.equal((await request('/api/projects/engineering', { method: 'DELETE', key: admin })).status, 204);
});

test('private hierarchy endpoints enforce reader, writer and CSRF boundaries', async t => {
  const { request, login, reader, writer, store } = await fixture(t);
  const etag = (await store.tree()).etag;
  assert.equal((await request('/api/pages/hidden/parent')).status, 401);
  assert.equal((await request('/wiki/hidden/parent')).status, 303);
  assert.equal((await request('/api/pages/hidden/parent', { key: reader })).status, 200);
  assert.equal((await request('/api/pages/hidden/parent', { method: 'PUT', key: reader, json: { parent: null }, headers: { 'if-match': etag } })).status, 403);
  const readSession = await login(reader);
  assert.equal((await request('/wiki/hidden/parent', { cookie: readSession.cookie })).status, 403);
  const { cookie } = await login(writer);
  const movePage = await request('/wiki/hidden/parent', { cookie });
  const form = { parent: '', etag: field(movePage.text, 'etag'), csrf: field(movePage.text, 'csrf') };
  assert.equal((await request('/wiki/hidden/parent', { method: 'POST', cookie, form: { ...form, csrf: 'wrong' } })).status, 403);
  assert.equal((await request('/wiki/hidden/parent', { method: 'POST', cookie, form, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/wiki/hidden/parent', { method: 'POST', cookie, form })).status, 303);
});

test('browser subpage forms, move recovery, ancestors and active sidebar branches stay coherent', async t => {
  const { request, login, store } = await fixture(t);
  const { cookie } = await login();
  const newPage = await request('/projects/default/new?parent=hidden', { cookie });
  assert.match(newPage.text, /option value="hidden" selected/);
  const create = await request('/projects/default/new', { method: 'POST', cookie, form: { csrf: field(newPage.text, 'csrf'), slug: 'child', markdown: '# Child', parent: 'hidden' } });
  assert.equal(create.status, 303); assert.equal(create.headers.get('location'), '/wiki/child');
  await store.create('grandchild', '# Grandchild', 'child');
  const article = await request('/wiki/grandchild', { cookie });
  assert.equal((article.text.match(/class="page-branch" open/g) || []).length, 2);
  assert.match(article.text, /href="\/wiki\/grandchild" aria-current="page"/);
  assert.match(article.text, /class="breadcrumb"><a href="\/">Library<\/a><span>\/<\/span><a href="\/wiki\/hidden">Confidential title<\/a>/);
  assert.match((await request('/wiki/hidden', { cookie })).text, /aria-label="Subpages"/);
  const move = await request('/wiki/child/parent', { cookie });
  assert.ok(!move.text.includes('<option value="grandchild"'));
  assert.ok(!move.text.includes('<option value="child"'));
  const form = { csrf: field(move.text, 'csrf'), etag: field(move.text, 'etag'), parent: '' };
  await store.create('another', '# Another');
  const conflict = await request('/wiki/child/parent', { method: 'POST', cookie, form });
  assert.equal(conflict.status, 412); assert.match(conflict.text, /The page has not moved/);
  const retry = await request('/wiki/child/parent', { method: 'POST', cookie, form: { ...form, etag: field(conflict.text, 'etag') } });
  assert.equal(retry.status, 303); assert.equal((await store.tree()).parents.child, null);
  assert.equal((await store.tree()).parents.grandchild, 'child');
  const bad = await request('/projects/default/new', { method: 'POST', cookie, form: { csrf: field(newPage.text, 'csrf'), slug: 'child', markdown: '# Retain draft', parent: 'hidden' } });
  assert.equal(bad.status, 409); assert.match(bad.text, /Retain draft/); assert.match(bad.text, /option value="hidden" selected/);
});


test('missing files and interrupted creates cannot revive stale parents; invalid tree storage fails safely', async t => {
  const { store, directory } = await fixture(t);
  await store.create('child', '# Child', 'hidden');
  await unlink(path.join(directory, 'pages/hidden.md'));
  assert.equal((await store.tree()).parents.child, null);
  await store.create('hidden', '# New root');
  assert.equal((await store.tree()).parents.child, null);
  const filename = path.join(directory, 'pages/.tree.json');
  await writeFile(filename, JSON.stringify({ phantom: 'hidden' }));
  await store.create('phantom', '# New page');
  assert.equal((await store.tree()).parents.phantom, null);
  await writeFile(filename, JSON.stringify({ child: 'hidden', hidden: 'child' }));
  await assert.rejects(store.tree(), error => error.code === 'invalid_tree');
  await assert.rejects(store.create('unsafe', '# Must not write'), error => error.code === 'invalid_tree');
  await assert.rejects(store.get('unsafe'), error => error.status === 404);
  await unlink(filename);
  await symlink(path.join(directory, 'keys.json'), filename);
  await assert.rejects(store.tree(), error => error.code === 'invalid_tree');
});
