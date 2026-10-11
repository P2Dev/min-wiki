# Security

## Access model

`WIKI_VISIBILITY=public` permits anonymous reading. `WIKI_VISIBILITY=private` protects the library, project names, search, rendered pages, source views and content APIs. Static reader assets, authentication routes and `/health` remain reachable. Invalid visibility or incomplete Cognito configuration fails startup. This setting does not affect GitHub repository visibility.

- `read` keys can read all projects; `write` keys can also create, update and delete pages.
- `admin` keys can additionally manage projects and keys.
- Every signed-in user of the configured Cognito pool and app client receives **write access across all projects**. Control pool enrollment accordingly. A configured Cognito group grants admin access.
- Projects are organizational namespaces, not independent security boundaries.
- Wiki keys contain 32 random bytes. Only hashes and metadata are persisted; secrets are shown once. Local revocation is checked on subsequent API and session requests.

## Browser and Cognito security

Cognito managed login uses authorization code + PKCE, single-use cookie-bound state, and validated local return destinations. The server verifies access-token signatures, issuer, client ID, token use and expiration through AWS's JWT verifier. ID tokens and machine-to-machine tokens are not accepted as user credentials.

Opaque browser session IDs use HttpOnly, SameSite=Lax cookies, with Secure and `__Host-` naming on HTTPS. Sessions are held in memory and expire within one hour or the credential's earlier expiration. Browser editor and logout forms require CSRF tokens. API requests require explicit Bearer authorization and do not accept session cookies.

Offline JWT verification does not immediately observe Cognito revocation, disabled users or changed groups; previously issued tokens/sessions may remain usable until expiry. Browser logout ends the local session and requests managed-login logout, but does not revoke independently held Bearer tokens or necessarily sign out upstream identity providers. See [authentication](docs/authentication.md) for details.

## Storage and deployment boundaries

Raw Markdown HTML is escaped; default Markdown URL validation and template escaping are retained. Responses apply a restrictive Content Security Policy. Strict slugs and no-follow page reads reject API path traversal and serving page symlinks. Network images referenced by page authors may be loaded by readers; private mode is access control, not a content-data-loss-prevention system.

Filesystem access is administrative access. Keep the data directory, environment secrets and backups protected. Use one process and local disk per data directory. External file edits must not race API writes. Restore operations must reconcile key revocation because old key metadata can reactivate previously revoked keys.

The service binds to localhost by default. Network deployments need HTTPS and suitable request limits at a reverse proxy. Set `PUBLIC_URL` explicitly to the external HTTPS origin. No per-project membership, audit history, automatic backups, multi-instance sessions, distributed coordination or TLS termination is built in.

## Reporting a vulnerability

Contact a repository administrator privately through an existing trusted channel. Do not open a public issue with access keys, client secrets, private content or an exploit targeting a live deployment. Provide the affected revision, steps using disposable data, expected behavior and observed behavior. Revoke exposed wiki keys immediately and rotate exposed Cognito app-client secrets through AWS.
