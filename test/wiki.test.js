import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import { Store, acquireLock } from '../src/store.js';
import { renderMarkdown } from '../src/render.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'min-wiki-test-'));
  const errors = [];
  const app = await createApp({ dataDir: directory, onError: error => errors.push(error) });
  const admin = await app.locals.store.issueKey('Test administrator', 'admin');
  const writer = await app.locals.store.issueKey('Publishing client', 'write');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, { key, json, ...options } = {}) => {
    const response = await fetch(base + url, { ...options, headers: { ...(key ? { Authorization: `Bearer ${key.secret || key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : undefined };
  };
  return { directory, store: app.locals.store, request, admin, writer, errors };
}

test('public reader, search, Markdown export and restart persistence', async t => {
  const { request, writer, directory } = await fixture(t);
  assert.match((await request('/')).text, /Your wiki starts here/);
  const markdown = '# Field **notes**\n\nUnique observation.\n\n## Details\n\n[Other page](other.md)';
  const created = await request('/api/pages', { method: 'POST', key: writer, json: { slug: 'field-notes', markdown } });
  assert.equal(created.status, 201);
  assert.equal(created.data.title, 'Field notes');
  assert.equal(created.headers.get('location'), '/api/pages/field-notes');
  assert.equal(await readFile(path.join(directory, 'pages/field-notes.md'), 'utf8'), markdown);
  const read = await request('/api/pages/field-notes');
  assert.equal(read.status, 200);
  assert.equal(read.data.markdown, markdown);
  assert.equal(read.headers.get('etag'), created.data.etag);
  const raw = await request('/api/pages/field-notes/raw');
  assert.equal(raw.text, markdown); assert.match(raw.headers.get('content-type'), /text\/markdown/);
  const source = await request('/wiki/field-notes/source');
  assert.ok(source.text.includes(markdown)); assert.match(source.headers.get('content-type'), /text\/html/);
  assert.match(source.text, /Back to the page/);
  assert.equal((await request('/api/pages?q=OBSERVATION')).data.total, 1);
  assert.equal((await request('/api/pages?q=nothing')).data.total, 0);
  assert.match((await request('/?q=nothing')).text, /No pages found/);
  const html = await request('/wiki/field-notes');
  assert.equal(html.status, 200); assert.match(html.text, /href="\/wiki\/other"/);
  assert.match(html.text, /id="details"/); assert.match(html.text, /href="#details"/);
  assert.match(html.headers.get('content-security-policy'), /default-src 'none'/);
  const reopened = new Store(directory); await reopened.init();
  assert.equal((await reopened.get('field-notes')).markdown, markdown);
  assert.equal((await reopened.authenticate(writer.secret)).role, 'write');
});

test('all mutations require valid keys and key management requires admin', async t => {
  const { request, writer } = await fixture(t);
  for (const [method, url] of [['POST', '/api/pages'], ['PUT', '/api/pages/a'], ['DELETE', '/api/pages/a'], ['POST', '/api/keys'], ['DELETE', '/api/keys/id']]) {
    assert.equal((await request(url, { method, json: {} })).status, 401);
    assert.equal((await request(url, { method, key: 'invalid', json: {} })).status, 401);
  }
  assert.equal((await request('/api/keys')).status, 401);
  assert.equal((await request('/api/keys', { key: writer })).status, 403);
  assert.equal((await request('/api/keys', { method: 'POST', key: writer, json: { name: 'No', role: 'admin' } })).status, 403);
  assert.equal((await request('/api/pages?key=' + writer.secret, { method: 'POST', json: { slug: 'no', markdown: '# No' } })).status, 401);
});

test('keys are hashed, metadata-only when listed, persisted and revocable', async t => {
  const { request, admin, directory } = await fixture(t);
  const key = await request('/api/keys', { method: 'POST', key: admin, json: { name: 'Script', role: 'write' } });
  assert.equal(key.status, 201); assert.match(key.data.secret, /^mw_[\w-]{43}$/);
  assert.equal(key.headers.get('cache-control'), 'no-store');
  const disk = await readFile(path.join(directory, 'keys.json'), 'utf8');
  assert.ok(!disk.includes(key.data.secret)); assert.match(disk, /"hash"/);
  assert.equal((await stat(path.join(directory, 'keys.json'))).mode & 0o777, 0o600);
  const listing = await request('/api/keys', { key: admin });
  assert.ok(!listing.text.includes('hash')); assert.ok(!listing.text.includes('secret'));
  assert.equal((await request(`/api/keys/${key.data.id}`, { method: 'DELETE', key: admin })).status, 204);
  assert.equal((await request('/api/pages', { method: 'POST', key: key.data.secret, json: { slug: 'denied', markdown: '# No' } })).status, 401);
  assert.equal((await request(`/api/keys/${admin.id}`, { method: 'DELETE', key: admin })).data.error.code, 'last_admin');
  const replacement = (await request('/api/keys', { method: 'POST', key: admin, json: { name: 'Replacement', role: 'admin' } })).data;
  assert.equal((await request(`/api/keys/${admin.id}`, { method: 'DELETE', key: replacement.secret })).status, 204);
  assert.equal((await request('/api/keys', { key: admin })).status, 401);
});

test('conditional updates and concurrent clients cannot silently lose edits', async t => {
  const { request, writer } = await fixture(t);
  const created = await request('/api/pages/a', { method: 'PUT', key: writer, headers: { 'If-None-Match': '*', 'Content-Type': 'text/markdown' }, body: '# A' });
  assert.equal(created.status, 201);
  assert.equal((await request('/api/pages', { method: 'POST', key: writer, json: { slug: 'a', markdown: '# Duplicate' } })).status, 409);
  assert.equal((await request('/api/pages/a', { method: 'PUT', key: writer, headers: { 'If-None-Match': '*' }, json: { markdown: '# Duplicate' } })).status, 412);
  assert.equal((await request('/api/pages/a', { method: 'PUT', key: writer, json: { markdown: '# Change' } })).status, 428);
  const updates = await Promise.all(['One', 'Two'].map(title => request('/api/pages/a', { method: 'PUT', key: writer, headers: { 'If-Match': created.data.etag }, json: { markdown: `# ${title}` } })));
  assert.deepEqual(updates.map(result => result.status).sort(), [200, 412]);
  assert.equal((await request('/api/pages/a', { method: 'DELETE', key: writer, headers: { 'If-Match': created.data.etag } })).status, 412);
  const latest = await request('/api/pages/a');
  assert.equal((await request('/api/pages/a', { method: 'DELETE', key: writer, headers: { 'If-Match': latest.data.etag } })).status, 204);
  assert.equal((await request('/api/pages/a')).status, 404);
  const races = await Promise.all([1, 2].map(() => request('/api/pages', { method: 'POST', key: writer, json: { slug: 'race', markdown: '# Race' } })));
  assert.deepEqual(races.map(result => result.status).sort(), [201, 409]);
});

test('validation, body limits and traversal are bounded JSON errors', async t => {
  const { request, writer } = await fixture(t);
  for (const slug of ['../outside', 'UPPER', 'a/b', 'a--b', '', 'a'.repeat(101)]) {
    const result = await request('/api/pages', { method: 'POST', key: writer, json: { slug, markdown: '# Invalid' } });
    assert.equal(result.status, 400); assert.equal(result.data.error.code, 'invalid_slug');
  }
  for (const markdown of ['', '   ', null, 123, '\0']) assert.equal((await request('/api/pages', { method: 'POST', key: writer, json: { slug: 'bad', markdown } })).status, 400);
  assert.equal((await request('/api/pages', { method: 'POST', key: writer, json: { slug: 'large', markdown: 'x'.repeat(256 * 1024 + 1) } })).status, 413);
  assert.equal((await request('/api/pages', { method: 'POST', key: writer, headers: { 'Content-Type': 'application/json' }, body: '{oops' })).data.error.code, 'invalid_json');
  assert.equal((await request('/api/pages?q=' + 'x'.repeat(201))).status, 400);
  assert.equal((await request('/api/pages/%2e%2e%2fkeys')).status, 400);
  assert.equal((await request('/api/pages/%ZZ')).status, 400);
  assert.equal((await request('/data/keys.json')).status, 404);
  assert.equal((await request('/wiki/missing')).status, 404);
  assert.equal((await request('/api/unknown')).data.error.code, 'endpoint_not_found');
});

test('hostile Markdown and titles do not become executable HTML', async t => {
  const { request, writer } = await fixture(t);
  const markdown = '# <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n## Repeat\n\n## Repeat\n\n## Repeat-2';
  await request('/api/pages', { method: 'POST', key: writer, json: { slug: 'hostile', markdown } });
  const html = (await request('/wiki/hostile')).text;
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img src=x')); assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /&lt;script&gt;/);
  const rendered = renderMarkdown(markdown, 'hostile');
  assert.equal(new Set(rendered.outline.map(item => item.id)).size, 3);
  const source = await request('/wiki/hostile/source');
  assert.ok(!source.text.includes('<script>')); assert.match(source.text, /&lt;script&gt;/);
  const searched = await request('/?q=' + encodeURIComponent('"><script>alert(1)</script>'));
  assert.ok(!searched.text.includes('<script>'));
});

test('symlinks cannot expose files or be overwritten', async t => {
  const { directory, request, writer } = await fixture(t);
  const external = path.join(directory, 'secret.md'); await writeFile(external, 'Private content');
  await symlink(external, path.join(directory, 'pages/secret.md'));
  assert.equal((await request('/api/pages/secret')).status, 404);
  assert.equal((await request('/api/pages')).data.total, 0);
  assert.equal((await request('/api/pages', { method: 'POST', key: writer, json: { slug: 'secret', markdown: '# Replaced' } })).status, 409);
  assert.equal(await readFile(external, 'utf8'), 'Private content');
});

test('data lock rejects a second owner and releases cleanly', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'min-wiki-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await acquireLock(directory);
  await assert.rejects(acquireLock(directory), /already in use/);
  await release();
  const releaseAgain = await acquireLock(directory); await releaseAgain();
});

test('CLI initializes once and actual server restart preserves data', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'min-wiki-process-'));
  const env = { ...process.env, DATA_DIR: directory };
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function cli() {
    const child = spawn(process.execPath, ['src/cli.js', 'init'], { env });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'exit'); return { code, output };
  }
  const initialized = await cli(); assert.equal(initialized.code, 0); assert.match(initialized.output, /mw_[\w-]{43}/);
  assert.equal((await cli()).code, 1);
  const app = await createApp({ dataDir: directory });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  async function runAndStop() {
    const child = spawn(process.execPath, ['src/server.js'], { env: { ...env, PORT: String(port) } });
    try {
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited with ${code}`))); });
      const pages = await (await fetch(`http://127.0.0.1:${port}/api/pages`)).json(); assert.equal(pages.total, 3);
    } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
  }
  await runAndStop(); await runAndStop();
});
