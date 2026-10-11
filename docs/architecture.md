# Architecture decisions

Research date: 2026-10-11. This is an implementation comparison for a small API-managed wiki, not a throughput benchmark. User requirements: Node.js, Markdown source files, public reading and keys for mutations.

## HTTP service

| Approach | Strength for this project | Cost / tradeoff | Decision |
| --- | --- | --- | --- |
| Node built-in HTTP | No framework dependencies; complete control | Routing, body limits, response types and error handling become application code | Too much low-level code for the benefit |
| Express 5 | Small routing/middleware model, JSON/text parsing, async error propagation, static assets | Validation and API contracts remain explicit application responsibilities | Selected: easy to inspect, no compilation or plugin system needed |
| Fastify | Schema validation/serialization and structured plugin model | Helpful if the API grows; introduces a schema/plugin structure for a handful of routes | Credible alternative; no demonstrated requirement for its added structure here |

The [Node HTTP API](https://nodejs.org/api/http.html) is intentionally low-level. [Express documents async error handling](https://expressjs.com/en/guide/error-handling/). [Fastify documents its validation and serialization model](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/). The choice is based on project fit, not a claim that one framework is universally faster or safer.

## Persistence and content model

| Approach | Advantages | Costs / risks |
| --- | --- | --- |
| Plain `.md` files | Directly readable, portable, easy backup, exactly matches the requested backing data | No multi-process transactions; scanning search is suitable only for a small collection |
| SQLite holding page bodies | Transactions, indexed search, convenient metadata | Markdown ceases to be the actual file-based source of truth |
| Markdown plus SQLite index | Files remain canonical, better search at volume | Two stores to reconcile; rebuild and stale-index semantics |
| Git-backed writes | History and rollback | Commit identity, locking, conflicts and repository maintenance on every write |

Selected: flat `data/pages/<slug>.md`. First level-one Markdown heading is the display title; absent headings fall back to the slug. No required frontmatter or metadata sidecar. Files are read fresh, so external changes appear without rebuilding. Local filesystem timestamps are informational; content SHA-256 drives ETags.

Writes use a same-directory temporary file followed by rename, serialized in the process. Existing-page updates/deletes require `If-Match` so two API clients cannot unknowingly overwrite each other. A process lock prevents two service/CLI instances using the same data directory. Direct filesystem editors are trusted and must not write concurrently with API edits. Atomic replacement protects readers from partial API writes; it is not a revision history or a substitute for backups. See [Node filesystem operations and concurrency caveats](https://nodejs.org/api/fs.html).

## Markdown rendering

| Approach | Fit | Tradeoff |
| --- | --- | --- |
| markdown-it | CommonMark-oriented parser, tables/fenced code, tokens for titles and outlines | Additional features need explicit plugins |
| Marked plus sanitizer | Straightforward parser and sanitizer pipeline | Raw rendered HTML must pass an independently configured sanitization policy |
| MDX | Rich embedded components | Executable content and build complexity conflict with simple stored Markdown |

Selected: markdown-it with raw HTML disabled and default URL validation retained. Escape all template strings separately. Add stable, collision-free heading anchors and rewrite local `.md` links to reader routes. A restrictive Content Security Policy is a second layer. No executable content or remote scripts/fonts. [markdown-it documentation](https://markdown-it.github.io/markdown-it/) describes its syntax and defaults; [Marked explicitly warns that it does not sanitize output](https://marked.js.org/).

## Authentication and API contract

| Approach | Fit | Tradeoff |
| --- | --- | --- |
| One environment key | Minimal bootstrap | Shared identity, rotation interrupts every client, no selective revocation |
| Opaque random keys with stored hashes | Per-client names, simple revocation, no secret recovery from the key registry | Registry must be backed up/protected; clients must retain secrets |
| JWTs | Distributed verification | Signing-key lifecycle and revocation complexity without a distributed system |
| OAuth / accounts | Delegated end-user identity | Outside an automation-oriented minimal wiki |

Selected: generated 256-bit secrets, SHA-256 hashes at rest, constant-time hash comparison, Bearer authorization only. `write` keys mutate pages; `admin` keys also issue/list/revoke keys. Public GET routes need no key. Creation returns the secret exactly once with `Cache-Control: no-store`; normal key listing never returns hashes or secrets. Initial admin creation and recovery use a local CLI while the server is stopped. No default credentials, browser key storage, cookie authentication or cross-origin write grants. [Node crypto](https://nodejs.org/api/crypto.html) provides random generation, hashing and timing-safe equality.

REST uses JSON page objects and a separate raw Markdown endpoint; writes accept JSON `{markdown}` or `text/markdown` for direct file uploads. Stable error codes, bounded request bodies, strict slugs, explicit conflict responses, and examples make the API usable by scripts. There is no need for an SDK for this target.

## Reader and visual direction

Server-rendered HTML versus an SPA: rendering on the server keeps articles, search and navigation usable without JavaScript, avoids a frontend build and duplicated fetching state. A browser editor would justify more client state later; it is not currently required.

Theme comparison: Quiet Workspace suits ongoing collaboration but gives editing/workspace controls more prominence. Editorial Journal supports essays but is less natural for technical reference. Theme Atlas's Technical Reference is selected: left page navigation, a constrained article column, local outline, monospace examples, fine dividers and one muted blue accent. Attributes: readable, restrained, precise, approachable. Non-goals: dashboard statistics and decorative marketing sections. Light theme only, system fonts, no imagery or motion required.

## Journeys and checks

| Actor / entry | Path | Completion / recovery |
| --- | --- | --- |
| Reader / home | Pick a page or search body/title; follow headings and local links | Read article or raw Markdown; no-results state retains query and offers all pages |
| Reader / direct link | Open article | Missing page explains absence and links back to all pages |
| Integrator / API guide | Initialize admin key; create writer key; POST page | Public article renders saved source; malformed input gives actionable JSON errors |
| Integrator / existing page | GET page + ETag; PUT or DELETE with If-Match | Stale ETag returns 412; fetch latest and reconcile before retrying |
| Administrator / key API | Issue named writer key; revoke by ID | Secret shown once; revoked key immediately fails; final admin cannot revoke itself |

Verification combines HTTP integration tests, real file inspection and browser walkthroughs at narrow, medium and wide widths. This is expert/functional evaluation, not representative-user research or a full accessibility certification.
