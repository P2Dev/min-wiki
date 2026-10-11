# Private access, Cognito and projects

Status: version 0.2 implemented and locally verified, 2026-10-11. Confirmed scope: integrate an existing User Pool; every signed-in Cognito user can edit; projects share wiki permissions. The GitHub repository's public visibility is independent of a deployed wiki's content visibility.

## Outcomes

1. An operator can make the entire deployed wiki private, including its browser reader, search, page metadata, source views and content API.
2. An operator can connect an AWS Cognito User Pool for human sign-in and authenticated API requests, while retaining existing integration access keys.
3. Projects organize wiki pages. All projects share the wiki’s read, write and admin permissions.

The existing Markdown storage, ETag edit protection and public-mode behavior must survive this change. No AWS account or User Pool configuration has been supplied, so a live Cognito login cannot yet be verified.

## Visibility boundary

Selected configuration: `WIKI_VISIBILITY=public|private`, retaining `public` as the backward-compatible default and rejecting invalid values at startup. This is a deployment setting; it does not change the GitHub repository's visibility.

Private mode checks read authorization before loading any content. This covers home, project lists, navigation titles, search, rendered pages, Markdown source, JSON and raw Markdown, and the API guide's content-bearing navigation. Browser requests go to sign-in and preserve a validated local return URL. API clients receive a JSON 401 response. Static reader CSS, sign-in/callback endpoints and a minimal health endpoint can remain reachable without content access.

Existing writer and admin keys retain their capabilities. A `read` key role allows integrations to read a private wiki without also granting changes. Bearer authorization remains the API contract. A browser session must not silently authorize API writes without a deliberate CSRF design.

## Cognito choices

| Approach | Benefit | Tradeoff |
| --- | --- | --- |
| Verify User Pool access tokens only | Small addition for API clients | Does not provide browser sign-in for a private reader |
| Cognito managed login and verified API tokens | Complete human and integration access | Requires callback/logout configuration, session handling and provider-failure behavior |
| Collect passwords and use Cognito authentication APIs | Full control of login UI | Adds MFA, password-reset and challenge handling to the wiki |

Selected: managed login with authorization code + PKCE for browsers, and a maintained JWT verifier for Cognito access tokens. Avoid collecting Cognito passwords in the wiki. Opaque wiki session IDs should be stored in HttpOnly cookies; provider tokens must not appear in URLs, logs, browser storage or rendered HTML.

Verify signature, expiration, configured User Pool issuer, app-client ID and `token_use=access`. An ID token must not be accepted as API authorization. Validate OAuth state and callback binding, consume login transactions once, restrict return URLs to the local application, and cap pending transactions and sessions. Session expiry must not outlive the verified credential; server restart can require sign-in again in this single-process implementation.

Confirmed role policy: every signed-in Cognito user receives writer privileges; an explicitly configured Cognito group grants admin privileges. Cognito's `aws.cognito.signin.user.admin` scope is not a wiki administrator role. Group changes and JWT revocation have token-lifetime implications; offline signature verification alone does not immediately observe provider-side revocation. Document that limit and keep wiki access-key revocation checked locally.

Existing-pool integration requires a pool ID/issuer, app-client ID, managed-login domain, registered callback/logout URLs and any client secret. App-client IDs and pool IDs are configuration, but client secrets belong in deployment secret storage. The selected scope integrates an existing pool; creating AWS infrastructure is excluded.

## Project choices

| Model | What it means | Cost |
| --- | --- | --- |
| Namespaces with shared wiki permissions | Every authorized reader sees all projects; pages and search are grouped by project | Small storage/API/navigation extension |
| Projects with independent membership | Different users/keys can access different projects | Requires project-aware authorization on every read, listing, search and write, plus membership administration |
| Plan now, implement later | Access work proceeds against current storage | Defers URL/storage changes until the project model is settled |

Selected model: project namespaces with shared wiki permissions. Use a project slug and page slug as the identity, allowing each project to have its own `welcome` page. Add project navigation and project-scoped search/API routes. Keep old `/wiki/:slug` and `/api/pages/:slug` links as aliases for a default project, preserving existing files without a destructive migration.

Do not label projects as a privacy boundary unless independent authorization is implemented and verified. A namespace is organization, not access isolation. Creating/removing projects and the behavior of nonempty deletion must be explicit; the safe initial deletion behavior is to reject removal of a nonempty project.

## Acceptance evidence

- Existing public-mode and key-management tests continue to pass.
- In private mode, anonymous requests cannot discover page titles, content, search results or source through any supported route or error path.
- Read/write/admin permissions are exercised with keys and Cognito tokens, including wrong issuer/client, expired tokens, wrong token type, invalid signatures and insufficient groups.
- Browser sign-in, preserved local destination, expiry, logout, provider denial, invalid/replayed callback state and safe error recovery are tested.
- Local cryptographic tests exercise the actual verifier with test signing keys; a live configured User Pool is required to claim AWS end-to-end login verification.
- Duplicate slugs, scoped search/links, legacy compatibility, traversal rejection and nonempty-project deletion are covered.
- Browser review covers the private entry point and project navigation at narrow and desktop widths, with keyboard access.

## Sources

Primary sources reviewed on 2026-10-11:

- [Cognito authorization-code PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html)
- [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)
- [Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)
- [Cognito access-token claims and verification boundaries](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html)
- [Cognito managed-login logout](https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html)
- [AWS JWT verifier](https://github.com/awslabs/aws-jwt-verify)

Browser verification also informed the form security headers: [`same-origin` referrer policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy) preserves the Origin header on local form posts while withholding cross-site referrers. The [CSP form-action allowlist](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action) includes the configured Cognito origin to permit managed-login logout redirects.
