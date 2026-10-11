# Minimal wiki MVP

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

Next: no further work is required for the local MVP and repository-publication target. Optional future capabilities remain out of scope until requested.
