# Contributing

## Development setup

Use Node.js 24 or newer. `.nvmrc` selects Node 24 if you use nvm.

```sh
npm ci
npm run init
npm run dev
```

Save the administrator key printed by initialization. The development server restarts on source changes. Use disposable local pages for development; do not commit your runtime data or access keys. An existing installation should skip initialization and use its existing data directory.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/server.js` | Environment configuration, process lock, listener and shutdown |
| `src/app.js` | HTTP routes, authentication middleware, validation and error responses |
| `src/store.js` | Markdown files, atomic writes, conditional edits and key registry |
| `src/render.js` | Markdown rendering, HTML escaping and reader templates |
| `src/cli.js` | First-run setup and local administrator recovery |
| `public/style.css` | Responsive reader styles |
| `examples/` | Starter Markdown pages copied during initialization |
| `test/wiki.test.js` | HTTP, filesystem, security-boundary and process integration tests |
| `docs/` | API guide, design decisions, operations and preview |

## Make a change

Keep changes focused on a concrete wiki use case. Read [architecture.md](docs/architecture.md) before changing persistence, authentication, or rendering. Plain Markdown files remain the source of truth; the supported deployment model is one process per local data directory.

Update the API guide when changing routes, request bodies, permissions, preconditions, or error codes. Keep operational instructions aligned with actual startup and recovery behavior. Add tests for changed behavior or permission boundaries rather than tests that simply repeat implementation details.

## Verify

```sh
npm run check
npm test
```

Tests create temporary data directories and bind local HTTP servers on ephemeral ports. They require permission to listen on localhost. They do not use your running wiki, require a GitHub token, or depend on an external service. The suite exercises initialization, process restart, page operations, key roles and revocation, conflicts, unsafe Markdown, and filesystem boundaries.

For reader changes, also inspect the real app at narrow, intermediate, and desktop widths. Exercise search, links, source view, heading navigation and keyboard focus. Code blocks and tables should scroll locally without widening the page. The reader should remain usable without JavaScript.

GitHub Actions runs the syntax and integration checks on Node 24 for pushes and pull requests. Passing CI is a functional check, not proof of hosted deployment or full accessibility conformance.

## Submit

Use a branch and a pull request for follow-up work. Explain the user-visible change, the problem it solves, how it was tested, and any storage or API compatibility implications. Do not include access keys, personal wiki content, runtime data, or unrelated dependency updates.
