import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export class Problem extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
export const fail = (status, code, message) => { throw new Problem(status, code, message); };
export const digest = text => createHash('sha256').update(text).digest('hex');
export const validSlug = slug => typeof slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 100;
export function checkSlug(slug) {
  if (!validSlug(slug)) fail(400, 'invalid_slug', 'Use a slug of 1–100 lowercase letters, digits and single hyphens.');
  return slug;
}
export function checkMarkdown(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) fail(400, 'invalid_markdown', 'Provide a non-empty markdown string.');
  if (Buffer.byteLength(markdown) > 256 * 1024) fail(413, 'too_large', 'A page may contain at most 256 KiB of Markdown.');
  if (markdown.includes('\0')) fail(400, 'invalid_markdown', 'Markdown cannot contain null characters.');
  return markdown;
}

export async function atomicWrite(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

// Never automatically delete a stale lock: concurrent startup could otherwise
// remove a new owner's lock. Recovery is an explicit local administrator action.
export async function acquireLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, '.lock');
  try {
    const file = await open(filename, 'wx', 0o600);
    try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
    return () => unlink(filename);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(filename, 'utf8'));
    throw new Error(`This data directory is already in use (lock PID ${pid}). Stop its owner first. If it crashed, verify no wiki process is running before removing ${filename}.`);
  }
}

export class Store {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.pages = path.join(this.directory, 'pages');
    this.keysFile = path.join(this.directory, 'keys.json');
    this.projectsFile = path.join(this.directory, 'projects.json');
    this.projectsDirectory = path.join(this.directory, 'projects');
    this.pending = Promise.resolve();
  }
  async init() {
    await mkdir(this.pages, { recursive: true, mode: 0o700 });
    await mkdir(this.projectsDirectory, { recursive: true, mode: 0o700 });
  }
  async projects() {
    let projects = [];
    try { projects = JSON.parse(await readFile(this.projectsFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return [{ slug: 'default', name: 'General', description: 'Your original wiki pages.' }, ...projects];
  }
  async project(slug) {
    checkSlug(slug);
    const project = (await this.projects()).find(item => item.slug === slug);
    if (!project) fail(404, 'project_not_found', 'This project does not exist.');
    return project;
  }
  async forProject(slug = 'default') {
    const project = await this.project(slug);
    if (slug === 'default') return this;
    const directory = path.join(this.projectsDirectory, slug);
    const parent = await lstat(this.projectsDirectory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail(404,'project_not_found','Project storage is unavailable.');
    if (project.cloud) await mkdir(directory,{mode:0o700}).catch(error => { if(error.code !== 'EEXIST') throw error; });
    for (const location of [this.projectsDirectory, directory]) {
      const info = await lstat(location);
      if (!info.isDirectory() || info.isSymbolicLink()) fail(404, 'project_not_found', 'This project is not available.');
    }
    const scoped = new Store(this.directory);
    scoped.pages = directory;
    scoped.serialize = work => this.serialize(work);
    return scoped;
  }
  createProject(slug, name, description = '') {
    checkSlug(slug);
    if (typeof name !== 'string' || !name.trim() || name.length > 80) fail(400, 'invalid_name', 'Provide a project name of 1–80 characters.');
    if (typeof description !== 'string' || description.length > 280) fail(400, 'invalid_description', 'Project description must be at most 280 characters.');
    return this.serialize(async () => {
      const projects = await this.projects();
      if (projects.some(item => item.slug === slug)) fail(409, 'project_exists', 'This project slug already exists.');
      if (projects.length >= 100) fail(409, 'project_limit', 'This wiki supports at most 100 projects.');
      if (!(await lstat(this.projectsDirectory)).isDirectory()) fail(500, 'storage_error', 'Project storage is unavailable.');
      const directory = path.join(this.projectsDirectory, slug);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') fail(409, 'project_exists', 'This project directory already exists.'); throw error; }
      const project = { slug, name: name.trim(), description: description.trim(), createdAt: new Date().toISOString() };
      try { await atomicWrite(this.projectsFile, JSON.stringify([...projects.slice(1), project], null, 2) + '\n'); }
      catch (error) { await rmdir(directory); throw error; }
      return project;
    });
  }
  deleteProject(slug) {
    if (slug === 'default') fail(409, 'default_project', 'The General project cannot be deleted.');
    return this.serialize(async () => {
      if ((await this.project(slug)).cloud) fail(409,'cloud_project','Cloud-linked projects retain their identity and pages; archive them in Cloud instead.');
      const scoped = await this.forProject(slug);
      if ((await readdir(scoped.pages)).length) fail(409, 'project_not_empty', 'Delete or move all files before deleting this project.');
      const projects = (await this.projects()).filter(item => item.slug !== 'default' && item.slug !== slug);
      // Remove the directory first; if metadata persistence fails, recreate the empty directory.
      await rmdir(scoped.pages);
      try { await atomicWrite(this.projectsFile, JSON.stringify(projects, null, 2) + '\n'); }
      catch (error) { await mkdir(scoped.pages, { mode: 0o700 }); throw error; }
    });
  }
  serialize(work) {
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }
  async get(slug) {
    checkSlug(slug);
    let file;
    try {
      file = await open(path.join(this.pages, `${slug}.md`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile()) fail(404, 'page_not_found', 'This page does not exist.');
      if (stat.size > 256 * 1024) fail(413, 'too_large', `Page ${slug} exceeds the 256 KiB limit.`);
      const markdown = await file.readFile('utf8');
      return { slug, markdown, updatedAt: stat.mtime.toISOString(), etag: `"${digest(markdown)}"` };
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes(error.code)) fail(404, 'page_not_found', 'This page does not exist.');
      throw error;
    } finally { await file?.close(); }
  }
  async list() {
    const entries = await readdir(this.pages, { withFileTypes: true });
    const pages = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || !validSlug(entry.name.slice(0, -3))) continue;
      try { pages.push(await this.get(entry.name.slice(0, -3))); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    return pages;
  }
  create(slug, markdown) {
    checkSlug(slug); checkMarkdown(markdown);
    return this.serialize(async () => {
      // Exclusive creation also prevents replacing an existing symlink.
      const filename = path.join(this.pages, `${slug}.md`);
      try { await this.get(slug); fail(409, 'page_exists', 'A page with this slug already exists.'); }
      catch (error) { if (error.status !== 404) throw error; }
      // A temporary file is linked into place exclusively, so reads never see partial content.
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await atomicWrite(temporary, markdown);
        await link(temporary, filename);
      } catch (error) {
        if (error.code === 'EEXIST') fail(409, 'page_exists', 'A page with this slug already exists.');
        throw error;
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return this.get(slug);
    });
  }
  change(slug, markdown, etag, remove = false) {
    checkSlug(slug); if (!remove) checkMarkdown(markdown);
    if (!etag) fail(428, 'precondition_required', 'Send the current ETag in the If-Match header.');
    return this.serialize(async () => {
      const page = await this.get(slug);
      if (etag !== page.etag) fail(412, 'version_conflict', 'The page changed. Fetch its latest content and ETag, reconcile your edit, and retry.');
      const filename = path.join(this.pages, `${slug}.md`);
      if (remove) { await unlink(filename); return; }
      await atomicWrite(filename, markdown);
      return this.get(slug);
    });
  }
  async keys() {
    try { return JSON.parse(await readFile(this.keysFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async authenticate(token) {
    if (typeof token !== 'string' || !/^mw_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = Buffer.from(digest(token), 'hex');
    return (await this.keys()).find(key => (!key.expiresAt || Date.parse(key.expiresAt)>Date.now()) && timingSafeEqual(hash, Buffer.from(key.hash, 'hex'))) ?? null;
  }
  issueKey(name, role) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) fail(400, 'invalid_name', 'Provide a key name of 1–80 characters.');
    if (!['read', 'write', 'admin','projects:sync'].includes(role)) fail(400, 'invalid_role', 'Choose read, write, admin or projects:sync.');
    return this.serialize(async () => {
      const keys = await this.keys();
      if (keys.length >= 100) fail(409, 'key_limit', 'Revoke unused keys before creating more (limit 100).');
      const secret = `mw_${randomBytes(32).toString('base64url')}`;
      const key = { id: randomUUID(), name: name.trim(), role, createdAt: new Date().toISOString(), hash: digest(secret) };
      if (role === 'projects:sync') key.expiresAt = new Date(Date.now()+90*86400000).toISOString();
      await atomicWrite(this.keysFile, JSON.stringify([...keys, key], null, 2) + '\n');
      const { hash, ...metadata } = key;
      return { ...metadata, secret };
    });
  }
  revokeKey(id) {
    return this.serialize(async () => {
      const keys = await this.keys();
      const key = keys.find(item => item.id === id);
      if (!key) fail(404, 'key_not_found', 'This key does not exist.');
      if (key.role === 'admin' && keys.filter(item => item.role === 'admin').length === 1) fail(409, 'last_admin', 'Create another admin key before revoking the last administrator.');
      await atomicWrite(this.keysFile, JSON.stringify(keys.filter(item => item.id !== id), null, 2) + '\n');
    });
  }
}
