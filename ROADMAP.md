# Minimal wiki delivery status

## Version 0.3: subpages and collapsible navigation

Current target: readers can browse a page tree, and writers can create subpages or move existing pages through the browser and API. Preserve stable URLs, exact Markdown, existing permissions and independent content preconditions. Implemented and locally verified on 2026-10-11. All 26 tests and syntax checks pass, covering persistence, cycle/depth limits, stale/concurrent moves, deletion protection, project isolation, permissions/CSRF, invalid storage and browser forms. Browser walkthrough passed subpage creation, moving between parents, promotion to top level, ancestor links, and keyboard collapse/expand; 320px and 800px views have no document overflow, and the desktop reader was inspected. Delivery is a committed and pushed review branch with documentation. See [the nested reader preview](docs/subpages-preview.jpg).

Chosen design: a per-project parent map; native disclosure navigation; parent selection on new pages; a separate move form; reject cycles and deleting parents with children. See [subpages](docs/subpages.md) for the approach comparison and storage/recovery contract. Custom sibling ordering and saved expansion state remain optional future work.

## Version 0.2: private access, Cognito and projects

Implemented and locally verified on 2026-10-11. Accepted scope: integrate an existing Cognito User Pool; give every signed-in user write access; organize pages into project namespaces with shared wiki permissions. See the [approach comparison](docs/private-access-and-projects.md), [authentication setup](docs/authentication.md), and [project contract](docs/projects.md).

- Whole-wiki public/private configuration protects content, titles, search, source views and APIs. Read/write/admin keys continue to work.
- Cognito authorization code + PKCE, access-token validation, bounded server-side sessions, CSRF-protected forms, logout and optional admin-group mapping are implemented.
- Project navigation, scoped search/links/API routes and browser create/edit forms are implemented. Original URLs and Markdown files remain the General project without migration.
- `npm run check` and all **20 tests** pass. Tests include actual RSA verification, invalid JWT claims/signatures, OAuth denial/replay, secure cookies, credential expiry, permissions, local-key revocation, conflicts, storage isolation and compatibility.
- Browser walkthrough passed: private redirect and preserved destination; invalid-key retry; editing and publishing; project switching by keyboard; logout; 320px login/library/editor layouts without document overflow; 800px and 1280px project navigation.
- Browser review found and fixed login-cookie replacement by favicon redirects and form Origin suppression by the old referrer policy. Regression coverage now checks both. [Project preview](docs/projects-preview.jpg).

Remaining deployment check: no live AWS pool configuration was supplied. Automated Cognito tests use a simulated token endpoint and test signing keys; verify managed login/logout and a real access token against your pool before deployment. No AWS infrastructure or application hosting is provisioned. Per-project membership, attachments and revision history remain outside this milestone.

## Historical initial delivery (version 0.1)

Target: deliver a locally runnable Node.js wiki with Markdown backing files, a polished public reader, and an API protected by revocable access keys for changes.

Confirmed: public reading; access keys for mutations; compare architectural approaches in depth before implementation. Delivery includes a GitHub repository under `p2dev`, with documentation, committed source and a pushed default branch. Application hosting has not been requested.

## Required outcomes

| Outcome | Acceptance evidence | Status |
| --- | --- | --- |
| Markdown is the source of truth | HTTP lifecycle tests, exact on-disk source, real server restart, raw export | Passed |
| Useful API | Search/list, explicit errors, JSON and file uploads, conditional writes, API guide | Passed |
| Protected changes | Missing/invalid/revoked keys denied; writer/admin boundaries; hashes only on disk | Passed |
| Safe content and storage | Hostile Markdown, invalid paths, symlinks, concurrent edits/creation, lock exclusion | Passed |
| Comfortable public reading | Browser walkthrough at 320, 800, 1280px; search, outline, source viewer, keyboard controls | Passed |
| Reproducible handoff | Lockfile, CLI init/re-init, start/restart tests, README and backup/recovery instructions | Passed |

Current state: delivered and verified on 2026-10-11. The source and documentation are published to the public [P2Dev/min-wiki](https://github.com/P2Dev/min-wiki) repository on `main`. The initial GitHub Actions run passed installation, syntax checks and all integration tests. No application hosting was requested or performed.

Constraints: one service process and local disk; flat page slugs; no browser editing, user accounts, revision history or attachments in this MVP. Keys are managed by CLI bootstrap and admin API. Optional later ideas do not block completion.

## Decisive verification

- `npm test`: 9 passing HTTP, filesystem, permission and process integration tests.
- `npm run check`: JavaScript syntax checks pass.
- [Initial GitHub Actions run](https://github.com/P2Dev/min-wiki/actions/runs/38169293264): passed on Node 24 / Ubuntu. Remote `main` was verified against the local initial commit.
- Dependency installation audit reported no vulnerabilities in 73 packages.
- Browser: library → article → section link; body-content search; no-results recovery; native disclosure using Enter; Markdown source view → back to article; focused source code horizontally scrolls using the keyboard.
- Rendered layouts inspected at 320, 800 and 1280 CSS pixels. At 320px, code/tables scroll locally and document scroll width equals viewport width. Compact outline moved before the article following the UX walkthrough.
- The embedded browser blocked direct raw-text navigation; the reader now has an HTML source viewer, while the API preserves raw `text/markdown` export. The corrected source-view journey was verified in the browser.
- Preview screenshot: [docs/preview.jpg](docs/preview.jpg).

Limits: functional and expert UI/UX evaluation, not representative-user research, screen-reader certification or cross-browser testing. Hosting, HTTPS termination and proxy rate limiting are deployment tasks documented in README. Search is a scan suitable for a small collection. No release blockers remain for the local MVP.

## Handoff

Clone the repository, run `npm ci`, then `npm run init` to create `data/` and reveal your admin secret once. Run `npm start` and open `http://127.0.0.1:3000`. Runtime pages, keys, environment files, and dependencies are excluded from version control. Example pages are included as initialization templates.

The initial local MVP and repository-publication target was completed. Version 0.2 work is described above.
