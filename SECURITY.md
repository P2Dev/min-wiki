# Security

## Access model

All wiki content is public to anyone who can reach the service. This includes rendered pages, search results, JSON responses, and raw Markdown. Access keys protect changes; they do not make pages private.

- `write` keys can create, update and delete pages.
- `admin` keys can also create, list and revoke keys.
- Keys are generated from 32 random bytes. The registry stores SHA-256 hashes and metadata, not reusable secrets.
- Key secrets are returned once at creation. Revocation denies subsequent requests; an already authorized request may finish.
- Authentication uses the `Authorization: Bearer` header. The reader does not use authentication cookies or save keys in browser storage.

## Boundaries

Raw HTML in Markdown is escaped and the Markdown parser's default URL validation is retained. Templates escape user-controlled strings, and responses apply a restrictive Content Security Policy. Strict slugs and no-follow file reads prevent API path traversal and serving page symlinks.

Filesystem access is administrative access. Anyone who can modify the service, its data directory or its environment can change the wiki or key registry. Keep runtime data and backups private to the service operator. Do not run multiple writers against the same directory or use shared network storage.

The server binds to localhost by default. Network deployments need HTTPS termination and appropriate request limits at a reverse proxy. There are no built-in accounts, private pages, key expiration, audit history, distributed coordination, TLS termination, or automatic backups. See [operations](docs/operations.md).

## Reporting a vulnerability

Report a suspected vulnerability privately to a repository administrator through an existing trusted contact channel. Do not open a public issue containing a working exploit, access key, key registry, or private deployment details. Provide the affected revision, reproduction steps using disposable data, expected behavior, and observed behavior. If a key has been exposed, revoke it immediately and issue a replacement.
