# Private access and Cognito

## Visibility

`WIKI_VISIBILITY=public` retains the original behavior: anyone can read; credentials are required for changes. Set `WIKI_VISIBILITY=private` to require sign-in or a Bearer token for every content-bearing route, including project lists, search, page titles, JSON, source views, and Markdown exports.

```sh
WIKI_VISIBILITY=private PUBLIC_URL=http://127.0.0.1:3000 npm start
```

Only static reader assets, sign-in/callback routes the empty favicon response, and `/health` remain public. Invalid visibility values fail startup. Visibility is read at startup; restart to change it. This setting is unrelated to whether this GitHub repository is public.

Browsers are directed to `/auth/login` and return to their original local destination after signing in. Without Cognito, users can sign in with wiki access keys. Existing `write` and `admin` keys also allow reading. Create a `read` key for someone who should read without publishing.

## Connect an existing Cognito User Pool

No AWS resources are provisioned by this application. Use an existing pool and app client with Cognito managed login enabled.

Configure the app client in AWS:

1. Enable the **authorization code grant** and the **openid** scope. The wiki uses PKCE with S256.
2. Set the allowed callback URL to `https://your-wiki.example/auth/callback`.
3. Set the allowed sign-out URL to `https://your-wiki.example/auth/login`.
4. Enable the intended identity providers on that app client.
5. Decide who can create accounts in the pool. **Every signed-in user of the configured pool and app client gets wiki write access across all projects.** If the pool permits public signup, those users can also edit this wiki. Control enrollment in Cognito accordingly.

Set these environment variables on the wiki service:

```sh
export WIKI_VISIBILITY=private
export PUBLIC_URL=https://your-wiki.example
export COGNITO_USER_POOL_ID=us-east-1_YourPool
export COGNITO_CLIENT_ID=your-app-client-id
export COGNITO_DOMAIN=https://your-domain.auth.us-east-1.amazoncognito.com
export COGNITO_ADMIN_GROUP=wiki-admins
npm start
```

`COGNITO_DOMAIN` must be the HTTPS origin of your managed-login domain, including the scheme and without an endpoint path. Custom domains are supported. If the app client has a secret, supply `COGNITO_CLIENT_SECRET` through your secret manager. It is used only by the server during code exchange. Do not commit it or put it in a browser configuration file.

`PUBLIC_URL` must be the exact externally visible origin; the callback and logout URLs are derived from it. HTTPS is required except for localhost development. Set it explicitly behind a reverse proxy; untrusted Host/forwarded headers do not determine OAuth destinations or cookie security. For local Cognito testing, use a localhost origin and register its exact callback and sign-out URLs in your app client.

The pool issuer and signing-key location are derived from the configured User Pool ID by AWS's verifier. The service needs outbound HTTPS access to that pool's signing keys and managed-login token endpoint. Partial Cognito configuration fails startup rather than silently disabling authentication.

## Roles and API tokens

| Credential | Read | Publish/update/delete pages | Manage projects and keys |
| --- | --- | --- | --- |
| Anonymous visitor, public mode | Yes | No | No |
| Anonymous visitor, private mode | No | No | No |
| `read` access key | Yes | No | No |
| `write` access key | Yes | Yes | No |
| `admin` access key | Yes | Yes | Yes |
| Signed-in Cognito user | Yes | Yes | No |
| Cognito user in configured admin group | Yes | Yes | Yes |

`COGNITO_ADMIN_GROUP` names one exact group. If it is unset, Cognito users do not gain administrative permissions; use a bootstrap admin key. Cognito's `aws.cognito.signin.user.admin` scope is not a wiki role. Group matching uses the verified token's `cognito:groups` claim.

API clients send either a wiki key or a **Cognito access token** in `Authorization: Bearer <credential>`. ID tokens are rejected. The service validates signatures, issuer, app-client ID, token use and expiration with `aws-jwt-verify`, and requires a human-user subject and username. Cognito machine-to-machine grants are outside this integration; use a wiki key for automation. `GET /api/me` reports the verified identity and role.

Browser session cookies do not authorize `/api` requests. Browser editor forms use their server-side session and CSRF tokens. This keeps existing script authorization explicit and avoids accidentally granting cross-origin API writes through a cookie.

## Sessions, logout and revocation

Sessions are held in memory and identified by opaque HttpOnly, SameSite=Lax cookies. HTTPS uses Secure cookies with a `__Host-` prefix. Sessions last at most one hour, and Cognito sessions never outlive the verified access token. Restarting the service signs out browser sessions; users can sign in again. Refresh tokens are not retained or used.

The Cognito flow binds a single-use authorization transaction to a browser cookie, verifies state, and exchanges the code with its PKCE verifier. Pending transactions expire after ten minutes. Sessions and pending transactions each have a 1,000-entry limit; expiry is pruned during requests. Provider failures return a recoverable error without logging token responses or client secrets.

Signing out invalidates the local session. Cognito users are then directed through managed-login logout. That does not necessarily sign them out of an upstream social/OIDC identity provider.

Wiki-key revocation invalidates subsequent API requests and browser session reads immediately. Cognito group changes, disabled users and provider-side token revocation are **not immediately detected by offline JWT verification**. Existing tokens/sessions may remain usable until expiration; choose a suitable access-token lifetime and use operational controls if immediate cutoff is required. Signing out the browser does not invalidate a separately copied Bearer token.

## Verify your live configuration

The automated suite uses real RSA signatures with test signing keys, the actual AWS verifier, and a simulated OAuth token endpoint. That proves local validation and flow behavior; it does not prove your AWS app-client configuration.

Before deploying, verify sign-in and sign-out against your actual pool, callback registration, writer/admin group assignment, an API call with a real access token, expiry behavior and private-mode anonymous denial. A live User Pool was not supplied during implementation, so that AWS end-to-end check remains an operator step.

## References

- [Authorization code and PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html)
- [Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)
- [Access-token claims](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html)
- [Managed-login logout](https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html)
- [AWS JWT verifier](https://github.com/awslabs/aws-jwt-verify)

Dedicated `projects:sync` keys are restricted to the Cloud integration endpoint and are not human sign-in credentials. See [Cloud synchronization](cloud-project-sync.md). Native reader/writer/admin credentials retain their documented privileges.
