export function readConfig(env = process.env) {
  const visibility = env.WIKI_VISIBILITY || 'public';
  if (!['public', 'private'].includes(visibility)) throw new Error('WIKI_VISIBILITY must be public or private.');
  const origin = new URL(env.PUBLIC_URL || `http://127.0.0.1:${env.PORT || 3000}`);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('PUBLIC_URL must be an origin without credentials, path, query or fragment.');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('PUBLIC_URL requires HTTPS except for local development.');
  const fields = ['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_DOMAIN'];
  const enabled = fields.some(key => env[key]) || Boolean(env.COGNITO_CLIENT_SECRET || env.COGNITO_ADMIN_GROUP);
  let cognito = null;
  if (enabled) {
    if (!fields.every(key => env[key])) throw new Error(`Cognito requires ${fields.join(', ')}.`);
    if (!env.PUBLIC_URL) throw new Error('Set PUBLIC_URL explicitly when enabling Cognito.');
    const domain = new URL(env.COGNITO_DOMAIN);
    if (domain.protocol !== 'https:' || domain.pathname !== '/' || domain.search || domain.hash || domain.username || domain.password) throw new Error('COGNITO_DOMAIN must be an HTTPS origin.');
    cognito = { userPoolId: env.COGNITO_USER_POOL_ID, clientId: env.COGNITO_CLIENT_ID, domain: domain.origin, clientSecret: env.COGNITO_CLIENT_SECRET || '', adminGroup: env.COGNITO_ADMIN_GROUP || '' };
  }
  return { visibility, publicUrl: origin.origin, secureCookies: origin.protocol === 'https:', cognito };
}
