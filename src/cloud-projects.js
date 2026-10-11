import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { atomicWrite, fail } from './store.js';

const fields = ['schemaVersion','cloudProjectId','revision','slug','code','name','description','appUrl','status'];
export function projection(input, id, requestKey) {
  const invalid = () => fail(400, 'invalid_projection', 'Supply a complete version-1 Cloud project projection.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input,field))) invalid();
  if (input.schemaVersion !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.cloudProjectId) || input.cloudProjectId !== id) invalid();
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || typeof input.slug !== 'string' || input.slug.length > 80 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug) || typeof input.code !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(input.code)) invalid();
  if (typeof input.name !== 'string' || !input.name || input.name !== input.name.trim() || input.name.length > 80 || typeof input.description !== 'string' || input.description.length > 20000 || !['active','archived'].includes(input.status)) invalid();
  if (input.appUrl !== null) {
    if (typeof input.appUrl !== 'string' || input.appUrl.length > 2048 || /[\\\r\n]/.test(input.appUrl)) invalid();
    try { const url = new URL(input.appUrl); if (url.protocol !== 'https:' || url.username || url.password) invalid(); } catch { invalid(); }
  }
  if (requestKey !== `cloud-project-${id}-r${input.revision}`) fail(400,'invalid_idempotency_key','Use cloud-project-{UUID}-r{revision}.');
  return Object.fromEntries(fields.map(field => [field,input[field]]));
}

export async function syncCloudProject(store, token, input, id, requestKey, publicUrl) {
  return store.serialize(async () => {
    // Recheck key revocation/expiry inside the same queue as key management and metadata writes.
    const actor = await store.authenticate(token);
    if (!actor) fail(401,'invalid_credentials','An active integration key is required.');
    if (actor.role !== 'projects:sync') fail(403,'insufficient_scope','Use a dedicated projects:sync key.');
    const value = projection(input,id,requestKey);
    const projects = await store.projects();
    const existing = projects.find(p => p.cloud?.cloudProjectId === id);
    if (existing && (existing.slug !== value.slug || existing.cloud.code !== value.code)) fail(409,'immutable_identity','Project slug and code cannot change.');
    if (existing && value.revision < existing.cloud.revision) fail(409,'stale_revision','A newer project revision is already stored.');
    const replayed = existing?.cloud.revision === value.revision;
    if (replayed && JSON.stringify(existing.cloud.payload) !== JSON.stringify(value)) fail(409,'revision_conflict','This revision has a different projection.');
    if (!existing) {
      if (projects.some(p => p.slug === value.slug || p.cloud?.code === value.code)) fail(409,'identity_collision','The project slug or code is already in use.');
      if (projects.length >= 100) fail(409,'project_limit','This wiki supports at most 100 projects.');
      try { await lstat(path.join(store.projectsDirectory,value.slug)); fail(409,'identity_collision','An existing directory requires explicit operator reconciliation.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!replayed) {
      const updated = { slug:value.slug,name:value.name,description:value.description,createdAt:existing?.createdAt || new Date().toISOString(),cloud:{cloudProjectId:id,code:value.code,revision:value.revision,payload:value} };
      // One durable atomic file contains namespace identity, latest revision and canonical payload.
      // Page directories are created lazily from this committed identity, so crashes cannot
      // leave a half-created namespace/ledger transaction or overwrite any existing pages.
      await atomicWrite(store.projectsFile,JSON.stringify([...projects.slice(1).filter(p => p !== existing),updated],null,2)+'\n');
    }
    return { status:existing ? 200 : 201,replayed,data:{schemaVersion:1,cloudProjectId:id,revision:value.revision,resourceType:'project',resourceId:value.slug,url:new URL('/projects/'+value.slug,publicUrl).href} };
  });
}
