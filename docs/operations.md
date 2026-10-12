# Operations

## Storage and startup

The service is designed for one Node.js process using a local filesystem. Use Node 24 or newer and install locked dependencies with `npm ci`.

Set `DATA_DIR` to a persistent directory outside a disposable release checkout. Relative values are resolved against the process working directory. Use the same value for every CLI and server invocation.

```sh
export DATA_DIR=/srv/min-wiki/data
npm run init
npm start
```

The operator must have write access to that directory. Initialization copies starter pages and prints the first administrator key once. Store that secret securely. `npm run key:create -- "Administrator name"` creates an admin without adding starter content; stop the server before either CLI operation.

Default listener: `127.0.0.1:3000`. Set `HOST` and `PORT` as needed. `GET /health` returns `{"status":"ok"}` when the HTTP service responds; it is a liveness check, not an assertion that every page or disk operation is healthy.

## Network deployment

Run the process as an unprivileged service user under your platform's process supervisor. Place a reverse proxy with HTTPS in front of it, keeping the Node listener private where possible. Configure request-rate and request-size limits at the proxy, forward the `Authorization`, `If-Match`, and `If-None-Match` headers, and do not log authorization values or request bodies containing secrets.

For Cognito or browser form use behind a proxy, set `PUBLIC_URL` to the external HTTPS origin. Configure User Pool callbacks as described in [authentication](authentication.md). Set `WIKI_VISIBILITY=private` when content must require sign-in; access is shared across projects. Browser sessions are in memory and a restart signs users out.

The application limits Markdown source to 256 KiB. JSON request bodies allow up to 300 KiB for encoding overhead; browser editor forms allow 800 KiB for URL encoding. Proxy limits should accommodate that overhead without accepting unbounded uploads. Responses use `Cache-Control: no-store`; do not override it for key-management responses.

There is no shared storage or cluster mode. Use one process per data directory. No automatic hosting or TLS configuration is supplied by this repository.

## Access-key rotation

1. Authenticate with a working admin key and create a replacement key through `POST /api/keys`.
2. Save its secret immediately and update the intended client.
3. Verify the client can make its expected request.
4. Revoke the old key with `DELETE /api/keys/:id`.

Create a replacement admin before revoking the final administrator. If all administrator secrets are lost, stop the service, run `npm run key:create -- "Recovery administrator"` with the correct `DATA_DIR`, and restart. Revoke the lost keys afterward. The registry allows at most 100 active keys; if that limit is reached and all admin secrets are lost, restore access using a protected known-good backup and local administrative review.

## Backup and restore

Stop the server before copying the entire data directory. Preserve `pages/`, `projects/`, `projects.json`, `keys.json` and all hidden `.tree.json` files; together they contain page content, active key hashes and key metadata. Store backups with restricted permissions. The application does not implement revision history, trash or automatic backup retention.

To restore:

1. Stop every service/CLI process using the destination data directory.
2. Preserve the current directory before replacing it with the selected backup.
3. Remove a copied `.lock` only after confirming no process owns the restored directory.
4. Ensure the service user owns and can read/write the restored directory.
5. Start the service with the restored `DATA_DIR`.
6. Check `/health`, read representative pages, and authenticate with an existing key.

Restoring `keys.json` also restores its historical revocation state. A key revoked after the backup may become valid again; reconcile or rotate keys after a restore. Test this procedure using a separate directory and port before relying on backups.

## Locks and shutdown

The server and CLI acquire `DATA_DIR/.lock`. A second owner is rejected. Normal SIGINT/SIGTERM shutdown stops accepting requests, finishes active work and releases the lock.

A forced termination or crash may leave `.lock` behind. The next startup identifies the lock and recorded PID. Verify that no service or CLI still owns the directory, then remove the stale lock and restart. Startup never automatically deletes locks, which avoids concurrent recovery attempts removing another process's new lock.

## Upgrades and rollback

Stop the process and make a backup before upgrading. Update the checkout, run `npm ci`, `npm run check` and `npm test`, then restart with the same `DATA_DIR`. Do not run `init` again for an established installation.

To roll back, restore the previous application revision and its locked dependencies. If a future release changes the data format, follow that release's migration and rollback instructions; do not assume an old executable can read new storage. The initial MVP stores ordinary UTF-8 Markdown and a JSON key registry.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No pages | Confirm `DATA_DIR` and supported lowercase `.md` filenames in `pages/` |
| Startup reports directory in use | Identify the running owner before touching `.lock` |
| 401 response | Bearer header, exact current secret, and revocation state |
| 403 response | Check role requirements, exact `PUBLIC_URL`, and a fresh form/CSRF token |
| 412 or 428 response | Fetch the current ETag, reconcile, and send exact `If-Match` |
| 413 response | Page or request body exceeds the supported limit |
| 500 response | Server logs, disk space, permissions, and valid key/hierarchy JSON; see `docs/subpages.md` for `invalid_tree` recovery |
| Port already in use | Stop the intended old instance or select a different `PORT` |

Search reads the collection on each request. If measured collection size or traffic makes this unsuitable, plan indexing separately; do not solve it by starting multiple instances against the same directory.
