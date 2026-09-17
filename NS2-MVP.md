# NS2 Play History MVP

Deployment and isolation instructions live in the repository README and `docs/ns2-backup.md`. Keep production paths and runtime state outside the source tree.

## Architecture

- Migration: `migrations/001_play_history.sql`
- Domain repository: `lib/play-history/repository.ts`
- Strict import validator: `lib/play-history/validation.ts`
- Admin APIs: `app/api/play-*`
- Admin UI: `features/play-history/play-history-client.tsx`
- Disabled connector status: `app/api/nintendo-connector/status/route.ts`

The implementation deliberately uses the same SQLite file only inside the NS2 instance. Production is exported read-only and never attached or mounted.
