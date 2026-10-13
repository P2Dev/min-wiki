import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { appRoleForGroups } from '@p2dev/common/roles';
import { cognitoGroups } from '@p2dev/common/auth';
import { FetchError } from 'aws-jwt-verify/error';
import { fail } from './store.js';
import { escape } from './render.js';

const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const can = (identity, role) => ({ read: 1, write: 2, admin: 3 }[identity?.role] || 0) >= ({ read: 1, write: 2, admin: 3 }[role] || Infinity);
export function localReturn(value) {
  if (typeof value !== 'string' || value.length > 2000) return '/';
  try {
    const decoded = decodeURIComponent(value);
    return /^\/(?!\/)/.test(decoded) && !/[\\\x00-\x20\x7f]/.test(decoded) && !/^\/auth(?:\/|\?|$)/i.test(decoded) ? value : '/';
  } catch { return '/'; }
}
function cookie(request, name) {
  const values = (request.headers.cookie || '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
export function createCognitoVerifier(config) {
  return CognitoJwtVerifier.create({ userPoolId: config.userPoolId, tokenUse: 'access', clientId: config.clientId });
}

export function createAuth(store, config, { verifier = config.cognito ? createCognitoVerifier(config.cognito) : null, fetchToken = fetch, now = Date.now } = {}) {
  const sessions = new Map();
  const transactions = new Map();
  const sessionCookie = config.secureCookies ? '__Host-mw_session' : 'mw_session';
  const flowCookie = config.secureCookies ? '__Host-mw_flow' : 'mw_flow';
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' };
  function prune(map) { for (const [key, value] of map) if (value.expires <= now()) map.delete(key); }
  function insert(map, id, value) {
    prune(map);
    if (map.size >= 1000) fail(503, 'auth_busy', 'Sign-in is temporarily busy. Please try again shortly.');
    map.set(hash(id), value);
  }
  function transaction(request, response) {
    const id = random();
    const flow = { csrf: random(), verifier: random(), next: localReturn(request.query.next), expires: now() + 10 * 60_000 };
    const previous = cookie(request, flowCookie);
    if (previous) transactions.delete(hash(previous));
    insert(transactions, id, flow);
    response.cookie(flowCookie, id, { ...cookieOptions, maxAge: 10 * 60_000 });
    return flow;
  }
  function consume(request, response) {
    const id = cookie(request, flowCookie);
    const value = transactions.get(hash(id));
    transactions.delete(hash(id));
    response.clearCookie(flowCookie, cookieOptions);
    if (!value || value.expires <= now()) fail(400, 'invalid_login', 'This sign-in attempt expired. Start again from the sign-in page.');
    return value;
  }
  async function tokenIdentity(token) {
    if (typeof token !== 'string' || token.length > 16_384) return null;
    if (token.startsWith('mw_')) {
      const key = await store.authenticate(token);
      return key && can(key,'read') ? { kind: 'key', id: key.id, name: key.name, role: key.role } : null;
    }
    if (!verifier) return null;
    try {
      const claims = await verifier.verify(token);
      if (!claims.sub || !claims.username || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) return null;
      const groups = cognitoGroups(claims);
      return { kind: 'cognito', id: claims.sub, name: claims.username, role: appRoleForGroups(groups, { adminGroup: config.cognito.adminGroup || '', memberRole: 'write' }), expires: claims.exp * 1000 };
    } catch (error) {
      if (error instanceof FetchError) fail(503, 'identity_unavailable', 'The identity provider is temporarily unavailable. Please try again.');
      return null;
    }
  }
  async function bearer(request) {
    const match = /^Bearer (\S+)$/i.exec(request.get('authorization') || '');
    return match ? tokenIdentity(match[1]) : null;
  }
  async function session(request) {
    prune(sessions);
    const result = sessions.get(hash(cookie(request, sessionCookie)));
    if (!result) return null;
    if (result.identity.kind === 'key') {
      const key = (await store.keys()).find(item => item.id === result.identity.id);
      if (!key || !can(key,'read') || (key.expiresAt && Date.parse(key.expiresAt)<=now())) { sessions.delete(hash(cookie(request, sessionCookie))); return null; }
      result.identity = { kind: 'key', id: key.id, name: key.name, role: key.role };
    }
    return result;
  }
  function startSession(request, response, identity) {
    sessions.delete(hash(cookie(request, sessionCookie)));
    const id = random();
    const expires = Math.min(now() + 60 * 60_000, identity.expires || Infinity);
    insert(sessions, id, { identity, csrf: random(), expires });
    response.cookie(sessionCookie, id, { ...cookieOptions, maxAge: expires - now() });
  }
  function csrf(request) {
    if (!request.webSession || !equal(request.body?.csrf, request.webSession.csrf)) fail(403, 'invalid_csrf', 'This form expired. Reload the page and try again.');
    if (request.get('origin') && request.get('origin') !== config.publicUrl) fail(403, 'invalid_origin', 'Submit this form from the wiki itself.');
  }
  const requireRole = role => (request, response, next) => {
    if (!request.identity) { response.set('WWW-Authenticate', 'Bearer realm="min-wiki"'); fail(401, 'unauthorized', 'Provide a valid access key or Cognito access token.'); }
    if (!can(request.identity, role)) fail(403, 'forbidden', `The ${role} role is required for this operation.`);
    next();
  };
  function loginPage(flow, error = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · min wiki</title><link rel="stylesheet" href="/assets/style.css"></head><body><main class="auth-page"><a class="brand" href="/">min wiki</a><p class="eyebrow">${config.visibility === 'private' ? 'Private knowledge base' : 'Your workspace'}</p><h1>A place for your team.</h1><p class="lead">Sign in to ${config.visibility === 'private' ? 'read and contribute to' : 'contribute to'} the wiki.</p>${error ? `<p role="alert" class="form-error">${escape(error)}</p>` : ''}${config.cognito ? `<a class="primary-button" href="/auth/cognito?next=${encodeURIComponent(flow.next)}">Continue with Cognito →</a><p class="auth-divider">or use a wiki access key</p>` : ''}<form action="/auth/key" method="post" class="stack-form"><input type="hidden" name="csrf" value="${escape(flow.csrf)}"><label for="access-key">Access key</label><input id="access-key" name="key" type="password" required autocomplete="off" maxlength="100"><p class="field-help">Use a key supplied by your wiki administrator.</p><button class="primary-button" type="submit">Sign in</button></form><p class="field-help">Access is shared across all projects. Keep your access key private.</p></main></body></html>`;
  }
  function routes(app) {
    const form = express.urlencoded({ extended: false, limit: '4kb' });
    app.get('/auth/login', (request, response) => response.type('html').send(loginPage(transaction(request, response))));
    app.post('/auth/key', form, async (request, response) => {
      const flow = consume(request, response);
      if (!equal(request.body?.csrf, flow.csrf)) fail(403, 'invalid_csrf', 'This form expired. Open the sign-in page and try again.');
      if (request.get('origin') && request.get('origin') !== config.publicUrl) fail(403, 'invalid_origin', 'Submit this form from the wiki itself.');
      const key = await store.authenticate(request.body?.key);
      if (!key || !can(key,'read')) {
        const retry = transaction({ query: { next: flow.next }, headers: request.headers }, response);
        return response.status(401).type('html').send(loginPage(retry, 'That access key is invalid or has been revoked. Try again.'));
      }
      startSession(request, response, { kind: 'key', id: key.id, name: key.name, role: key.role });
      response.redirect(303, flow.next);
    });
    app.get('/auth/cognito', (request, response) => {
      if (!config.cognito) fail(404, 'cognito_disabled', 'Cognito sign-in is not configured.');
      const flow = transaction(request, response);
      const url = new URL('/oauth2/authorize', config.cognito.domain);
      url.search = new URLSearchParams({ response_type: 'code', client_id: config.cognito.clientId, redirect_uri: `${config.publicUrl}/auth/callback`, scope: 'openid', state: flow.csrf, code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      response.redirect(url.href);
    });
    app.get('/auth/callback', async (request, response) => {
      if (!config.cognito) fail(404, 'cognito_disabled', 'Cognito sign-in is not configured.');
      const flow = consume(request, response);
      if (!equal(request.query.state, flow.csrf)) fail(400, 'invalid_login', 'Invalid sign-in state. Start a new sign-in attempt.');
      if (request.query.error || typeof request.query.code !== 'string' || request.query.code.length > 4096) fail(400, 'login_denied', 'Sign-in was not completed. Return to sign in and try again.');
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: config.cognito.clientId, redirect_uri: `${config.publicUrl}/auth/callback`, code: request.query.code, code_verifier: flow.verifier });
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (config.cognito.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${config.cognito.clientId}:${config.cognito.clientSecret}`).toString('base64')}`;
      let result;
      try { result = await fetchToken(`${config.cognito.domain}/oauth2/token`, { method: 'POST', headers, body: body.toString(), redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
      catch { fail(503, 'identity_unavailable', 'Cognito is temporarily unavailable. Return to sign in and try again.'); }
      if (!result.ok) fail(401, 'login_failed', 'Cognito could not complete sign-in. Start a new sign-in attempt.');
      let tokens;
      try { tokens = await result.json(); } catch { fail(503, 'identity_unavailable', 'Cognito returned an invalid response. Please try again.'); }
      const identity = await tokenIdentity(tokens.access_token);
      if (!identity || identity.kind !== 'cognito') fail(401, 'invalid_token', 'Cognito returned an invalid access token.');
      startSession(request, response, identity);
      response.redirect(303, flow.next);
    });
    app.post('/auth/logout', form, async (request, response) => {
      request.webSession = await session(request);
      csrf(request);
      const identity = request.webSession.identity;
      sessions.delete(hash(cookie(request, sessionCookie)));
      response.clearCookie(sessionCookie, cookieOptions);
      if (identity.kind === 'cognito') {
        const url = new URL('/logout', config.cognito.domain);
        url.search = new URLSearchParams({ client_id: config.cognito.clientId, logout_uri: `${config.publicUrl}/auth/login` }).toString();
        return response.redirect(303, url.href);
      }
      response.redirect(303, '/auth/login');
    });
  }
  return { bearer, session, requireRole, csrf, routes, tokenIdentity };
}
