# Publishing with the API

Bring notes from your scripts, tools, and everyday workflow into the wiki. A single request turns Markdown into a page your wiki readers can access.

## Get an access key

The administrator creates a **write** key for your integration. Keep it in a secret manager or environment variable; never include it in page content.

Writer keys can publish, update, and delete pages. Administrator keys can also create and revoke keys.

## Publish your first page

Set `WIKI_URL` to the wiki's address and `WIKI_KEY` to your access key, then send a page:

```sh
curl -X POST "$WIKI_URL/api/pages" \
  -H "Authorization: Bearer $WIKI_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"field-notes","markdown":"# Field notes\n\nSomething worth remembering."}'
```

The response includes the new page's URL and content version. Open `/wiki/field-notes` to see the rendered result.

## Update with confidence

Read a page before changing it. Its `ETag` identifies the content you read; send that value in `If-Match` when updating or deleting.

If someone else has changed the page, the API returns `412` so you can reconcile the new version before retrying. This protects work from accidental overwrites.

## Go further

The [API guide](/guide) covers file uploads, search, deletion, key management, and error responses, with examples you can adapt.
