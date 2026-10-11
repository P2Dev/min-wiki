# Working with the API

Read any page without signing in. To publish or change content, send an access key in the `Authorization` header. The same Markdown powers the API and the reading view.

## Start here

From the project directory, use Node.js 24 or newer:

```sh
npm ci
npm run init
npm start
```

Initialization adds three starter pages and displays your first administrator key once. Save it in a password manager. The service defaults to `http://127.0.0.1:3000`.

For the examples below, set `WIKI_URL` to your service address and `WIKI_KEY` to your key. Use a secret manager or a hidden shell prompt so the key does not enter your shell history. Use HTTPS when connecting over a network.

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

Use an **admin** key to create a separate **write** key for each integration. Writer keys can create, update, and delete pages; they cannot manage keys. Admin keys can do both.

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
| 403 | Writer key used for key management | Use an admin key |
| 404 | Page, key, or endpoint absent | Check the URL or identifier |
| 409 | Duplicate page, key limit, or last admin | Change the request as described |
| 412 | Stale version or conditional-create page already exists | Fetch and reconcile before retrying |
| 413 | Body or page too large | Keep page source within 256 KiB |
| 428 | No update/delete precondition | Send the page's exact ETag in If-Match |
| 500 | Unexpected server failure | Inspect server logs; retry after fixing the cause |

## Endpoint reference

| Method | Path | Access |
| --- | --- | --- |
| GET | `/health` | Public |
| GET | `/api/pages?q=term` | Public |
| GET | `/api/pages/:slug` | Public |
| GET | `/api/pages/:slug/raw` | Public |
| POST | `/api/pages` | Write or admin |
| PUT | `/api/pages/:slug` | Write or admin |
| DELETE | `/api/pages/:slug` | Write or admin |
| GET | `/api/keys` | Admin |
| POST | `/api/keys` | Admin |
| DELETE | `/api/keys/:id` | Admin |

Keep access keys out of URLs, Markdown, and browser storage. The browser reader has no key-entry form. Script and server clients can use the API directly; cross-origin browser writes are not enabled.
