# Working with the API

In public mode, read pages without signing in. In private mode, all content reads require authentication. Send a wiki access key or Cognito access token as `Authorization: Bearer <credential>`. The same Markdown powers the API and the reading view. See `docs/authentication.md` in the repository for private-access setup and Cognito session behavior.

## Start here

From the project directory, use Node.js 24 or newer:

```sh
npm ci
npm run init
npm start
```

Initialization adds three starter pages and displays your first administrator key once. Save it in a password manager. The service defaults to `http://127.0.0.1:3000`.

For the examples below, set `WIKI_URL` to your service address and `WIKI_KEY` to your key. Use a secret manager or a hidden shell prompt so the key does not enter your shell history. Use HTTPS when connecting over a network.

## Projects

The original `/api/pages` routes address the built-in General (`default`) project. Use `/api/projects/:project/pages` for another project; every page route below has the same suffix and behavior there. Search is scoped to that project. Page responses include a `project` slug.

Administrators create projects with `POST /api/projects` and JSON `{ "slug": "engineering", "name": "Engineering", "description": "Build notes" }`. Readers can list projects with `GET /api/projects` and fetch details with `GET /api/projects/:project`. Administrators can delete empty projects with `DELETE /api/projects/:project`; nonempty projects and General return `409`. All projects share wiki permissions. See the [project guide](/projects) for the available collections and the repository’s `docs/projects.md` for the full contract.

## Subpages

List/search results include a `parent` slug, or `null` for a root page. Create requests can include `parent` to place a new page beneath an existing page in the same project. Existing Markdown content responses and ETags remain unchanged.

Use `GET /api/pages/:slug/parent` to read the parent and hierarchy ETag. Move with `PUT /api/pages/:slug/parent`, JSON `{ "parent": "parent-slug" }` (or `null` for top level), and `If-Match` containing that hierarchy ETag. Both routes also work under `/api/projects/:project/pages`. A writer role is required for moves. Missing/stale hierarchy preconditions return `428`/`412`; a cycle returns `409`. A page with children cannot be deleted (`409 page_has_children`).

Content updates preserve hierarchy and reject a supplied `parent` field; use the parent endpoint for moves. Trees support up to 16 levels. See `docs/subpages.md` for browser controls, complete examples, storage and recovery details.

## Read and find pages

```sh
curl "$WIKI_URL/api/pages"
curl "$WIKI_URL/api/pages?q=markdown"
curl -i "$WIKI_URL/api/pages/welcome"
curl "$WIKI_URL/api/pages/welcome/raw"
```

The list returns `{ "pages": [...], "total": 3 }`, with title, slug, summary, update time, ETag, and reading URL for each page. Search matches the title and full Markdown, without case sensitivity. `total` is the number of matches; there is no pagination in this small-wiki MVP.

A single page includes `markdown`, rendered `html`, `title`, `slug`, `updatedAt`, `etag`, and `url`. The raw endpoint returns `text/markdown`. The response's `ETag` header identifies the exact content version.

## Publish a page

Create with a JSON body:

```sh
curl -X POST "$WIKI_URL/api/pages" \
  -H "Authorization: Bearer $WIKI_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"team-notes","markdown":"# Team notes\n\nA place to keep what we learn."}'
```

Or upload a Markdown file directly:

```sh
curl -X PUT "$WIKI_URL/api/pages/team-notes" \
  -H "Authorization: Bearer $WIKI_KEY" \
  -H 'If-None-Match: *' \
  -H 'Content-Type: text/markdown' \
  --data-binary @team-notes.md
```

Both return `201 Created`. An existing slug returns `409 page_exists` for POST or `412 page_exists` for conditional PUT. Visit `/wiki/team-notes` to read the result.

Slugs use lowercase letters, digits, and single hyphens, up to 100 characters. Each page supports up to 256 KiB of non-empty UTF-8 Markdown. The first `# Heading` becomes its title; without one, the slug supplies the title. Raw HTML is displayed as text for safety.

## Update without losing an edit

First fetch the page. Copy its complete `ETag` header value, including the double quotes, into a shell variable named `WIKI_ETAG`. Then send your new source:

```sh
curl -i "$WIKI_URL/api/pages/team-notes"

curl -X PUT "$WIKI_URL/api/pages/team-notes" \
  -H "Authorization: Bearer $WIKI_KEY" \
  -H "If-Match: $WIKI_ETAG" \
  -H 'Content-Type: text/markdown' \
  --data-binary @team-notes.md
```

Success returns `200` and the new ETag. Missing `If-Match` returns `428`. A stale ETag returns `412 version_conflict`: fetch the latest page, reconcile your edits, then retry using its new ETag. A wildcard `If-Match` is deliberately not accepted.

## Delete a page

Fetch the current ETag first, as with an update:

```sh
curl -X DELETE "$WIKI_URL/api/pages/team-notes" \
  -H "Authorization: Bearer $WIKI_KEY" \
  -H "If-Match: $WIKI_ETAG"
```

Success returns `204 No Content`. Deletion removes the Markdown file. Recovery requires your backup; this version does not keep revision history.

## Manage access keys

Use an **admin** key or a Cognito token with the configured admin-group membership to create a separate **write** key for each publishing integration. Create a **read** key for private read-only access. Writer keys can create, update, and delete pages; they cannot manage keys. Admin keys can do both.

```sh
curl -X POST "$WIKI_URL/api/keys" \
  -H "Authorization: Bearer $WIKI_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Publishing script","role":"write"}'

curl "$WIKI_URL/api/keys" \
  -H "Authorization: Bearer $WIKI_KEY"

curl -X DELETE "$WIKI_URL/api/keys/KEY_ID" \
  -H "Authorization: Bearer $WIKI_KEY"
```

Creation returns `id`, `name`, `role`, `createdAt`, and `secret`. Save the secret immediately: it is returned only once. Listing shows metadata only. Revocation takes effect on subsequent requests. The final admin key cannot be revoked until another exists. There is a maximum of 100 active keys.

If all administrator secrets are lost, stop the service and run `npm run key:create -- "Recovery administrator"` locally. Restart, then revoke lost keys through the API. Local access to the data directory is an administrative privilege.

## Responses and errors

API errors always have this shape:

```json
{
  "error": {
    "code": "version_conflict",
    "message": "The page changed. Fetch its latest content and ETag, reconcile your edit, and retry."
  }
}
```

| Status | Meaning | What to do |
| --- | --- | --- |
| 400 | Invalid slug, JSON, query, or Markdown | Correct the named field |
| 401 | Missing, invalid, or revoked key | Supply a current Bearer key |
| 403 | Insufficient role | Use a writer for page changes or admin for project/key management |
| 404 | Page, key, or endpoint absent | Check the URL or identifier |
| 409 | Duplicate page, key limit, or last admin | Change the request as described |
| 412 | Stale version or conditional-create page already exists | Fetch and reconcile before retrying |
| 413 | Body or page too large | Keep page source within 256 KiB |
| 428 | No update/delete precondition | Send the page's exact ETag in If-Match |
| 500 | Unexpected server failure | Inspect server logs; retry after fixing the cause |
| 503 | Identity provider unavailable or authentication capacity reached | Retry shortly; inspect provider availability |

## Endpoint reference

| Method | Path | Access |
| --- | --- | --- |
| GET | `/health` | Public |
| GET | `/api/me` | Authenticated |
| GET | `/api/projects` | Read |
| GET | `/api/projects/:project` | Read |
| POST | `/api/projects` | Admin |
| DELETE | `/api/projects/:project` | Admin |
| GET | `/api/pages?q=term` | Read |
| GET | `/api/pages/:slug` | Read |
| GET | `/api/pages/:slug/raw` | Read |
| POST | `/api/pages` | Write or admin |
| PUT | `/api/pages/:slug` | Write or admin |
| DELETE | `/api/pages/:slug` | Write or admin |
| GET | `/api/keys` | Admin |
| POST | `/api/keys` | Admin |
| DELETE | `/api/keys/:id` | Admin |

Keep access keys out of URLs, Markdown, and browser storage. Browser sign-in uses a server session; the browser editor submits CSRF-protected forms. Session cookies are not accepted as API authorization. Script and server clients use Bearer credentials directly; cross-origin browser API writes are not enabled. “Read” access in the table is anonymous only in public mode.
