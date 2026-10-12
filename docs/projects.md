# Projects

Projects are namespaces for pages, not separate access-control boundaries. A reader can read every project; writers can change pages in every project. Administrators manage the project list. Whole-wiki public/private mode applies uniformly.

## URLs and compatibility

The built-in project has slug `default` and display name **General**. Existing files stay in `data/pages/`; no migration is required. Existing `/wiki/:slug` and `/api/pages` routes remain supported and refer to General.

| Resource | Path |
| --- | --- |
| Project directory | `/projects` |
| Project library and search | `/projects/:project?q=term` |
| Rendered page | `/projects/:project/wiki/:slug` |
| Source view | `/projects/:project/wiki/:slug/source` |
| Browser editor | `/projects/:project/wiki/:slug/edit` |
| New-page form | `/projects/:project/new` |
| Project list/create API | `/api/projects` |
| Project details/delete API | `/api/projects/:project` |
| Project page API | `/api/projects/:project/pages` |

The page API supports the same read/create/update/delete/raw routes, body formats, key roles and ETag preconditions as the original API. The default project also has explicit `/projects/default` and `/api/projects/default/pages` aliases.

Each project has its own [collapsible page tree](subpages.md). Parent relationships stay inside the project; creating or moving a subpage preserves its URL. Search is scoped to the current project. A link such as `[Setup](setup.md#installation)` resolves inside that project. Use an absolute wiki path to link across projects. The same page slug can exist independently in multiple projects. The header brand returns to General; the sidebar project chooser and `/projects` directory switch collections.

## Create a project

```sh
curl -X POST "$WIKI_URL/api/projects" \
  -H "Authorization: Bearer $WIKI_ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"engineering","name":"Engineering","description":"Build notes and decisions"}'
```

Success returns `201` with `slug`, `name`, `description` and `createdAt`. Project slugs follow the page-slug rules. Names are 1–80 characters, descriptions at most 280 characters, and a wiki supports at most 100 projects including General. Project names/slugs are immutable in this version.

Create a page in the project:

```sh
curl -X POST "$WIKI_URL/api/projects/engineering/pages" \
  -H "Authorization: Bearer $WIKI_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"welcome","markdown":"# Engineering\n\nA shared place for build notes."}'
```

Open `/projects/engineering` to read or search its pages. Signed-in writers can use **New page** or **Edit page** in the browser. The editor retains a draft when a validation or version-conflict error occurs. On a conflict, copy your draft before reloading the latest content and merging it; stale edits never overwrite automatically.

## Remove a project

```sh
curl -X DELETE "$WIKI_URL/api/projects/engineering" \
  -H "Authorization: Bearer $WIKI_ADMIN_KEY"
```

Only empty projects can be removed. A nonempty directory returns `409 project_not_empty`, and General cannot be deleted. There is no cascade deletion, automatic page move, per-project membership, or per-project access-key scope.

## Storage

```text
data/
  pages/                  # General / default project (unchanged)
  projects.json           # Other project names and descriptions
  projects/
    engineering/
      welcome.md
  keys.json
```

Back up the entire data directory, including hidden `.tree.json` hierarchy files, project metadata and all project directories. Page files remain ordinary Markdown. Create projects through the API so metadata and directories stay aligned. Direct file edits are visible on subsequent reads, but must not race API writes.

Cloud-linked projects are managed through the [versioned integration endpoint](cloud-project-sync.md). Their names/descriptions and archive status follow Cloud revisions; local deletion is blocked to preserve durable identity and pages.
