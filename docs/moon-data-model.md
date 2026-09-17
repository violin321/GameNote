# Unified play-history data model

GameNote treats play history as the entry point to one stable logical game. A
logical game can receive evidence from Nintendo Store, Moon, Nintendo/Coral,
JSON imports and manual entries without turning each source into a duplicate
collection item. The collection ledger remains compatible with upstream
GameNote and records how a copy was acquired, owned or sold.

The model deliberately separates four concerns:

```text
game_entities (one logical game profile)
  ├─ source_bindings → play_games (source-specific evidence)
  │                    ├─ play_sessions
  │                    ├─ play_observations
  │                    ├─ moon_connector_* daily reports
  │                    └─ nintendo_store_* snapshots/history
  ├─ game_entity_purchase_links (current association decision)
  └─ game_entity_acquisitions → purchase_records (all confirmed copies)
```

## Logical identity and source bindings

`game_entities` is the stable identity used by history list/detail APIs.
`PlayGameSummary.id` and `entityId` are entity IDs; `sourceGameId` exposes the
representative `play_games.id` only for compatibility. New code must not use a
source row as the permanent identity of a game. Entity IDs are opaque,
immutable values allocated independently from `title_id`, `strong_key` and the
source row ID. A corrected Nintendo application ID therefore changes an
identity assertion, not the public URL of the game profile.

`play_games` remains the source-specific compatibility and time-series write
model. Every source row is attached to one entity through `source_bindings`.
Importers update their own row and evidence tables, then ensure the binding;
they do not overwrite another source's evidence.

Automatic merging is intentionally conservative. Only the same case-insensitive
`title_id` inside the same platform family (`nintendo` or `playstation`) is a
strong identity. Equal normalized titles do **not** auto-merge because ports,
regional releases and different games can share names. Official URL and
normalized title can suggest a collection association, but they are not strong
enough to collapse two logical game entities. A source that later gains a strong
ID can merge into the matching entity; incompatible strong IDs remain separate.
When a provisional entity is merged, `game_entity_aliases` keeps its previously
published ID resolvable and points it at the survivor. Detail and write APIs
therefore accept the stable entity ID, an older entity alias, or a legacy
`play_games.id` during the compatibility period. Database guards keep live
entity IDs and alias IDs in disjoint namespaces, and merge code redirects older
aliases directly to the final survivor rather than creating alias chains.

`strong_key` is recalculated from all current bindings. A sole source changing
from title ID A to B keeps its entity ID and updates the key; clearing its title
ID releases A. If only one source in a shared entity changes to incompatible B,
that binding splits into a new opaque entity while the A siblings retain their
profile and collection ownership.

When multiple sources share an entity, representative metadata and aggregate
semantics use this order:

1. Nintendo Store
2. Moon
3. Nintendo/Coral connector
4. JSON import
5. manual entry

This priority selects one summary contract; it never deletes lower-priority
evidence. The detail page may still show Moon days and exact/manual sessions
under a Store-backed game.

## Time semantics

The sources do not all describe the same quantity, so their totals must not be
added together.

| Source         | Stored meaning                                                                              | Entity summary when authoritative                                                       |
| -------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Nintendo Store | Account-level cumulative observation plus retained snapshot and rolling daily-history audit | Latest imported official cumulative seconds and play-day count                          |
| Moon           | Per-device, per-official-calendar-day aggregates                                            | Sum of retained game-day rows; play days are distinct official dates with positive time |
| Nintendo/Coral | Cumulative observations and any supplied timeline evidence                                  | Latest cumulative observation; dates come from the available observations/sessions      |
| JSON import    | Explicit sessions/observations supplied by the import                                       | Sum and date range of sessions when no stronger source exists                           |
| Manual         | User-entered exact-duration sessions                                                        | Sum and date range of manual/timeline sessions when no stronger source exists           |

Therefore the effective total is selected as:

```text
Store cumulative
  else Moon retained daily coverage
  else latest Nintendo/Coral cumulative observation
  else sum of JSON/manual sessions
```

Never calculate `Store + Moon`, `Moon + Coral`, or an official total plus manual
sessions. Those ranges can overlap. A Store cumulative value is the displayed
official total even if a newer manual session exists. The manual session remains
visible as evidence and recent activity but does not mutate the Store total.
Likewise, Moon coverage is not presented as an all-time total when the retained
daily window is incomplete.

The summary separates the date belonging to the authoritative metric from the
latest known activity. History's “recent” order uses the newest actual Store
play date, positive Moon report date or session end. A connector snapshot fetch
time is not treated as gameplay. This lets a manual session move a Store-backed
game to the top without adding that session to the official Store cumulative
total.

Moon reports are calendar-day aggregates, not sessions. Importing Moon data does
not write `play_sessions` or `play_observations`; it retains the official date,
time-zone offset and report status. Different devices contribute their reported
seconds separately, while the entity's play-day count de-duplicates the official
date. `CALCULATING` rows are provisional. A later fetch replaces the same
device/date, including a corrected zero-play day. Dates missing from a later
rolling response remain archived and are not interpreted as deletions.

Nintendo Store similarly preserves an immutable audit row for every successful
cumulative snapshot and upserts its available rolling daily details by official
date and external title identity. Missing days or titles in a later response are
not deletion instructions. Store daily details are audit evidence; they do not
replace the cumulative value or become fabricated sessions.

Recent activity includes only evidence with a meaningful occurrence date, such
as Moon daily rows and JSON/manual sessions. A cumulative Store or Coral snapshot
is not itself a play session and must not appear as one.

## Manual records

A manual session always belongs to a dedicated `play_games.source='manual'` row.
When the user adds it from an existing game profile, that row is bound to the
same entity. It is never inserted into a Store, Moon or Coral source row. This
keeps official cumulative and daily aggregates reproducible and auditable.

If no matching entity exists, manual entry creates a new entity. Selecting a
collection record can reuse an already-linked entity, a matching strong title ID,
or a unique official URL. A title match alone is not used to merge identities.
Manual sessions use their provided start time and duration; they do not invent
official Nintendo dates or cumulative observations.

## Collection and acquisitions

Upstream-compatible `ledger_documents` and `purchase_records` remain the
canonical collection ledger, including medium, region, purchase channel, price,
notes and sold status. Play history does not duplicate those ownership fields.

`game_entity_purchase_links` stores one current decision for the entity:
`suggested`, `confirmed` or `rejected`. `game_entity_acquisitions` retains every
confirmed `(entity, purchase_record)` pair, so two physical/digital copies are
not silently discarded when source identities later converge. The current UI
may show one primary decision while collection and dashboard summaries count all
confirmed acquisitions.

Entity decisions are projected to legacy `play_purchase_links` for upstream and
schema-v5 compatibility. Confirming, rejecting or replacing an association must
not delete source evidence. Deleting/tombstoning a collection item must not
delete play history. Creating a collection item from history inherits title,
platform, cover and official URL, then stores only the user's acquisition facts.
When one source binding splits from a shared entity, the legacy projection is
not treated as proof that the new game owns the old collection item. The old
entity retains its decision and acquisitions; the new entity starts unlinked
unless it already has its own decision or a schema-v5 user explicitly changed
that binding after a marker-only downgrade.

## Import, privacy and transaction rules

Moon snapshots are validated in full before a single SQLite transaction is
started. Replay is idempotent, report revisions replace prior values, and stale
fetches cannot overwrite newer snapshots. Existing manual sessions, association
decisions and import batches survive. Store imports likewise write their audit
snapshot, cumulative rows, daily history and entity bindings atomically.
The compatibility repair for directly inserted, unbound `play_games` rows takes
an immediate SQLite write transaction and rechecks under the lock, so concurrent
first reads cannot leave duplicate or orphan entities.

`moon_connector_*` tables are separate from any pre-existing deployment-specific
Moon tables. Moon uses installation-keyed account and device pseudonyms to scope
source identity. Raw Nintendo account IDs, player identities, nicknames, pairing
codes, authorization URLs and tokens are outside the application import
contract. Credentials and sidecar runtime state must remain outside the GameNote
database, browser payloads, logs and Git.

Public game application IDs may be retained as `title_id`; source-local external
IDs and pseudonyms are not user-facing account identity. Snapshot audit tables
retain normalized game/time data, counts, timestamps and payload hashes, not raw
credential-bearing responses.

## Migration and rollback

Schema v3 added the Moon source and daily aggregate tables. Schema v4/v5 added
Nintendo Store credentials metadata, cumulative snapshot audit and rolling daily
history. Schema v6 adds `game_entities`, `source_bindings`, entity association
decisions and acquisition history, then backfills every existing `play_games`
row. Existing rows with the same platform-scoped title ID converge; rows without
a strong ID intentionally receive separate entities. Backfilled entity IDs are
opaque and do not encode either the title ID or source row ID.

V6 is additive and keeps the legacy association projection. Its down migration
is a marker-only downgrade that preserves entity data. It refuses downgrade when
an entity has multiple acquisitions or an entity decision is not faithfully
projected to every legacy source row, because schema v5 cannot represent that
state safely. On a supported re-up, the original public entity ID follows its
logical source even when schema v5 corrected the title ID. A true merge records
the removed ID as an alias; a sibling split does not duplicate an unchanged
collection projection, while an explicit schema-v5 edit is retained.

Before a production upgrade, stop writers and take a verified SQLite backup
using SQLite backup/checkpoint tooling; do not copy a live WAL database
incompletely. Rehearse migration and run `integrity_check` and
`foreign_key_check` against the copy. Application and database rollback must be
planned together. Do not delete history or acquisitions merely to bypass a
rollback guard.
