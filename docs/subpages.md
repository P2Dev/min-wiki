# Subpages and page trees

Pages can belong to another page in the same project. The sidebar shows this hierarchy as a collapsible tree, with siblings sorted by title. Existing pages start at the top level. Moving a page does not change its slug, URL, Markdown file, or content ETag.

## In the browser

- Select **Add subpage** on a page to open a new-page form with that parent selected. The ordinary **New page** form also offers a **Parent page** choice.
- Select **Move page** to choose another parent or **Top level (no parent)**. A page's descendants stay with it. The form excludes the page itself and its descendants from the choices.
- Activate the arrow beside a parent to expand or collapse its subpages. Click the title to read the parent. Keyboard users can focus the disclosure and press Enter or Space, then tab to page links.
- The current page and its ancestors are expanded when a page loads. Other branches start collapsed. Expansion choices apply to the current document and are not saved across navigation.
- Article breadcrumbs link to ancestor pages. Parents also list their direct subpages below the article.

The reader remains usable without JavaScript. Narrow screens show the same vertical hierarchy in a bounded scrolling navigation area; the **Pages** disclosure can hide it entirely. Search includes every page in the current project, even inside collapsed branches.

Pages have at most one parent and can be nested up to 16 levels (including the root). Cycles and cross-project parents are rejected. Projects still share wiki permissions; the tree adds no new access-control boundary.

## API

Use `/api/pages` for General, or `/api/projects/:project/pages` for another project. Existing authorization rules apply: reads follow wiki visibility; changes require a writer or administrator Bearer credential.

Create a subpage with an optional `parent` slug:

```sh
curl -X POST "$WIKI_URL/api/pages" \
  -H "Authorization: Bearer $WIKI_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"installation","parent":"getting-started","markdown":"# Installation\n\nSet up your workspace."}'
```

Omit `parent` or use JSON `null` for a root page. JSON `PUT /api/pages/:slug` with `If-None-Match: *` also accepts `parent` when creating. A raw Markdown upload creates a root page.

List/search responses include `parent` on each page (`null` at the top level). Single-page content responses and raw exports retain their original shape and content ETag. Read or change a page's parent through the dedicated endpoint:

```sh
curl -i "$WIKI_URL/api/pages/installation/parent" \
  -H "Authorization: Bearer $WIKI_KEY"
```

Response: `{"slug":"installation","parent":"getting-started","etag":"\"tree-...\""}`. The same hierarchy ETag appears in the `ETag` header. Copy it exactly, including its quotes:

```sh
curl -X PUT "$WIKI_URL/api/pages/installation/parent" \
  -H "Authorization: Bearer $WIKI_KEY" \
  -H 'Content-Type: application/json' \
  -H "If-Match: $TREE_ETAG" \
  -d '{"parent":null}'
```

A move returns `200` with the current parent and hierarchy ETag. The hierarchy ETag covers the project's page membership and parent relationships. A concurrent create, delete or move can invalidate it; content-only edits do not. A missing precondition returns `428`; stale state returns `412 tree_conflict`. Read the latest relationship, reconcile the intended move, and retry. The browser refreshes parent choices after a failed move and requires another deliberate submission.

Use the content ETag for Markdown updates/deletes and the hierarchy ETag for moves. Content updates preserve the parent; a `parent` field on a content update is rejected to avoid silently ignoring the requested move. Separating these operations lets content editing and page organization proceed independently.

Deletion returns `409 page_has_children` until the page's direct children are moved or deleted. There is no cascade deletion. An absent parent returns `404 parent_not_found`, a cycle returns `409 parent_cycle`, and excessive nesting returns `400 tree_depth`.

## Storage, backups and failure recovery

Each project stores a hidden `.tree.json` file beside its Markdown files. It maps child slugs to parent slugs; root pages do not need entries.

```text
data/
  pages/
    getting-started.md
    installation.md
    .tree.json                 # { "installation": "getting-started" }
  projects/
    engineering/
      handbook.md
      .tree.json
```

Markdown remains exact user-authored text. There is no frontmatter injection, directory move, or URL migration. Existing directories without `.tree.json` are read as a flat collection. Back up the entire data directory **including hidden files**. The hierarchy file is limited to 1 MiB.

Writes share the existing process-wide mutation queue. A move atomically replaces only the hierarchy file. Creation writes the relationship first, then publishes the complete Markdown file with an exclusive link; missing-file entries are ignored. An interrupted or failed creation may leave an ignored metadata entry, which is pruned on the next tree write. Every new creation prunes missing relationships before reusing a slug, preventing an old relationship from being revived.

Leaf deletion removes the Markdown file; its now-unused metadata record is ignored. Empty projects can still be removed when only this bookkeeping file remains. Direct filesystem removals promote children of missing parents to the top level. Do not externally edit files concurrently with API writes.

Malformed, cyclic, oversized or symlinked hierarchy storage fails with `500 invalid_tree` rather than silently discarding structure. Stop the service, preserve the current data, and restore the matching hierarchy backup. Restoring page files and hierarchy together avoids reviving obsolete relationships. A rollback to an older application renders a flat collection; restore a consistent pre-upgrade backup before allowing that version to write.

## Design choices

| Approach | Benefit | Cost |
| --- | --- | --- |
| Nest Markdown directories and URLs | Filesystem directly represents the tree | Moving a subtree changes paths and links; migration and traversal rules become more complex |
| Embed parent information in Markdown | Content and hierarchy can share one atomic file | Alters raw user content or introduces frontmatter parsing and content/metadata coupling |
| Separate per-project parent map (selected) | Preserves exact Markdown, stable URLs and existing content preconditions | Requires metadata backup and explicit recovery behavior around multi-file creation |

A separate move form keeps organization changes independent of unsaved Markdown edits. Native disclosures fit the existing server-rendered reader and provide keyboard operation without adding a frontend bundle. Drag-and-drop sorting, custom sibling ordering, saved expansion preferences and cross-project moves are outside this change.
