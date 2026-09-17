# NS2 V2 migration runbook

V2 uses `ledger_documents` as the compatibility write model and maintains
`purchase_records` as its relational projection in the same SQLite transaction.
The document table is intentionally retained in this release.

`projection_hash` is the lowercase 64-character SHA-256 digest of the UTF-8
bytes of canonical purchase JSON: compact JSON, recursively sorted object keys,
and unchanged array order. Both migration backfill and repository writes use
`scripts/purchase-projection-json.mjs`, so source whitespace and object-key order do not
change the digest.

## Deployment-stage migration

Run only during deployment/startup, before the application accepts traffic:

```sh
APP_DATABASE_FILE=/path/to/ns2-copy.sqlite node scripts/migrate-play-history.mjs
```

Application requests never run schema migration. All GET paths open the already
migrated database without taking a migration write lock.

## Rollback

1. Stop the V2 application.
2. Restore the pre-migration database backup (preferred), or run the reviewed
   `migrations/002_purchase_projection.down.sql` against an isolated copy.
3. Switch application code back to the V1 release.
4. Verify the identity marker is `gamenote-ns2` and schema version is `1` before
   resuming traffic.

The down migration preserves every `purchase_records` row, the legacy JSON
ledger, and the V2 projection columns. V1 code ignores those additional columns;
rollback only changes the schema marker and migration record. This makes repeated
`down` execution a safe no-op, preserves soft-delete tombstones and confirmed
foreign-key links, and lets the next V2 `up` restore its marker without replaying
`ALTER TABLE`. Never run it while V2 application code is serving requests.
