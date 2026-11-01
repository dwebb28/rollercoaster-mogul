# Persistence guide

Each player's whole park is saved as **one versioned JSON document**, validated on the server and stored in SQLite.
This guide covers:

- what that document contains,
- how it's validated and migrated,
- the data that still lives only in the browser,
- a proposed design for production infrastructure.

For the meaning of each option, see [CUSTOMIZATION.md](CUSTOMIZATION.md), which is generated from the code.

## Current design

| Concern | Where | Notes |
| --- | --- | --- |
| Accounts | `users` table (`server/db.js`) | One row per OAuth identity (`provider`, `provider_id`). |
| Sessions | `sessions` table | Stored by the express-session store in `server/session-store.js`. Expired rows are purged every 15 minutes. |
| Parks | `parks` table: `user_id` (PK), `name`, `data`, `value`, `rating`, `guests`, `day`, `updated_at` | `data` is the park document as JSON text. The other columns are copied out of it for the leaderboard. **One park per user.** |
| Coaster design library | Browser `localStorage["rcm.designs"]` | List of `{ name, code, savedAt }`. Not synced to the server yet. |
| UI preferences | none | Camera position, speed and panel state aren't saved. |

**Save flow.**

1. The browser runs the simulation. It autosaves every 45 seconds while there are changes, and also when the tab is hidden (`main.js` → `save()`).
2. `PUT /api/park` sends `serialize(park)`.
3. The server runs `deserialize()` from the shared `src/shared/sim.ts`. This rejects malformed data and clamps every number to its allowed range. It then stores the canonical `serialize()` of the result, never the raw upload, and copies the leaderboard numbers out of the parsed park.
4. `GET /api/park` returns the stored document. The browser runs it through `deserialize()` again on load.

**Size.** A 24-guest park is about 35 KB of JSON. Guests make up most of it, at about 600 bytes each, so a full park of 600 guests is roughly 400 KB. The three per-tile layers (`tiles`, `litter`, `stains`, plus `pathStyles`) are 1,600-character strings, about 6.4 KB together. JSON compresses 5–10× with gzip.

## The park document (version 2)

The authoritative definition is the `Park` interface and its parts in
[`src/shared/types.ts`](../src/shared/types.ts). The TypeScript compiler checks every read and write
of the save against it. The tables below explain each field.

Fields are grouped by how they should be treated when this moves to real infrastructure:

- **Config**: chosen by the player and rarely changed.
- **State**: the running simulation.
- **Log**: append-mostly history.
- **Churn**: rewritten every frame.

### Top level

| Field | Type | Class | Validation and meaning |
| --- | --- | --- | --- |
| `version` | int | config | `2` today. `1` is accepted and migrated (see below). Anything else is rejected. |
| `name` | string ≤ 40 | config | Park name. |
| `seed` | uint32 | config | The seed the park was created from. It produced the starting map and luck. |
| `settings` | object | config | Every key in `SETTINGS_SCHEMA` (`src/shared/options.ts`), validated by `sanitizeSettings()`. Unknown keys are dropped and missing ones defaulted. |
| `uniforms` | `{ role: "#rrggbb" }` | config | Staff uniform colours. Only known roles and valid hex colours are kept. |
| `entranceFee` | int 0–100 | config | |
| `open` | bool | config | Park open to new guests. |
| `fence`, `locked` | bool | config | Barbed wire installed; exits locked (only allowed with the fence). |
| `rngState` | uint32 | state | The deterministic random number generator's position. The same `rngState` and the same inputs give the same future. |
| `time` | float seconds | state | Game time. Day = `floor(time / 60) + 1`. |
| `cash` | number | state | |
| `rating`, `safety`, `buzz` | numbers | state | 0–999, 0–100 and −100…100. |
| `weather` | `{ type, day }` | state | `type` is a key of `WEATHER`. |
| `effects` | `[{ id, until }]` | state | Timed effects (`outage`, `protest`). `until` is in game seconds. |
| `nextId` | int | state | Next object, guest or staff ID. On load it's raised above the largest ID present. |
| `tiles` | string(1600) of `0`–`2` | state | grass / path / entrance, one digit per tile, row-major (`y * 40 + x`). |
| `pathStyles` | string(1600) of `0`–`5` | config | Path style per tile (only meaningful on path tiles). |
| `litter` | string(1600) of `0`–`5` | state | Litter per tile. |
| `stains` | string(1600) of `0`–`3` | state | Blood per tile. |
| `objects` | array | state | See [Objects](#objects). Footprints may not overlap. Custom coasters are rebuilt from their track. |
| `guests` | array ≤ 1200 | churn | See [Guests](#guests). |
| `staff` | array ≤ 200 | churn | See [Staff](#staff). |
| `raid` | object or null | state | The active Pandemonium raid. It's dropped if no pandas are present. |
| `pandemonium` | object | state | `raids`, `defeated`, `escaped`, `captured`, `executions`, `nextRaidDay`. |
| `custody` | array ≤ 100 | state | People waiting for a verdict: `{ id, name, kind, gang, record, by, day }`. |
| `captives` | array ≤ 50 | state | Death row: `{ name }`. |
| `fallen` | array ≤ 500 | log | Officers killed: `{ name, role, by, day, payout }`. Feeds the memorial. |
| `stats` | object | log | Totals plus `today` (a ledger by category) and `history` (the last 30 days). |
| `thoughts`, `incidents`, `eventLog` | arrays ≤ 25 / 30 / 20 | log | Recent feeds for the UI. |
| `objectives` | string[] | log | IDs of completed goals. |

Fields starting with `_` (for example `_objAt`, `_layout`, `_design`, `_fx`, `_events`) and guest/staff `route` are
**never saved**. They're rebuilt on load by `rebuildIndex()` and `refreshCoaster()`.

### Objects

Every object has `id`, `kind` (must be in the catalogue), `x`, `y`, `w`, `h`, `paid` and `builtDay`. Optional fields:

| Field | Applies to | Notes |
| --- | --- | --- |
| `name` | any | Player rename, ≤ 40 chars. Prefab rides get a renamed definition through `rideDef()`. |
| `color` | rides, shops, statues, coasters | `#rrggbb` paint. On a custom coaster it's the track colour. |
| `price`, `open`, `broken`, `stats` | rides, shops | `stats = { riders, revenue }`. |
| `phase`, `timer`, `wait`, `queue`, `riders` | rides | Runtime. Queues and riders are **reset on load**, and those guests resume walking. |
| `corrupt`, `exposed`, `deals` | food and drink shops | Corrupt vendor state. |
| `track: { dir, pieces[] }`, `building`, `cars`, `trainColor` | `custom` | The design. Its layout, footprint, physics and stats are recomputed on load, so the physics can't be faked. |
| `pit`, `show` | `retribution` | An interrupted show returns its prisoners to `captives`. |
| `graves` | `memorial` | Headstone count. |

### Guests

Position (`x, y, nx, ny, t`), needs (`happy, hunger, thirst, bladder, energy, nausea` 0–100), `cash`, `pref` (1–10),
`thrift`, `timeIn`, and `type` (a key of `GUEST_TYPES`). Then:

- flags: `leaving`, `injured`, `high`, `umbrella`, `map`, `souvenir`, `atmUsed`
- crime state: `crime`, `crimeT`, `crimes`, `loot`, `heistLoot`, `spotted`, `gang`, `record`
- panda combat: `hp`, `maxHp`, `acc`

Every guest is restored walking. Their goal, queue and route are recomputed.

### Staff

`id`, `role`, `name`, position, `hp`/`maxHp`, `acc`, `down` (knockout seconds), `traits[]` (keys of `STAFF_TRAITS`).
`maxHp` is **recomputed** from the role and traits, so a tampered save can't create a super-officer.

## Versioning and migrations

- `SAVE_VERSION` in `src/shared/sim.ts` is the current format (2).
- `deserialize()` accepts the current version and every older one it knows how to upgrade. Anything else is rejected.
- **v1 → v2** (this change) adds `settings`, `seed`, `weather`, `buzz`, `effects`, `eventLog`, `pathStyles`, `uniforms`, object `name`/`color`/`builtDay`, coaster `cars`/`trainColor`, guest `type` and items, and staff `traits`. All are optional on input. A v1 save loads with the Normal preset, sunny weather, sandstone paths and no traits. It's written back as v2 on the next save.

**Adding a field.** Give it a safe default in `createPark()` and `createEmpty()`. Read it in `deserialize()` with clamping
(the `num()`, `isHexColor()` and allow-list patterns). Add a test that saves and reloads it. Only bump `SAVE_VERSION` when
the meaning of an existing field changes. Purely additive fields don't need a bump.

**Adding a setting.** Add one entry to `SETTINGS_SCHEMA` and read it as `park.settings.<key>`. Storage, validation, the
setup screen, the Rules panel and the docs (`npm run docs`) all follow automatically.

**When a breaking change comes,** introduce a migration chain rather than more conditionals:

```js
const MIGRATIONS = { 2: (d) => ({ ...d, version: 3, /* reshape */ }) };
while (data.version < SAVE_VERSION) data = MIGRATIONS[data.version](data);
```

## Proposed production infrastructure

The single-blob design is simple and correct. It strains under five needs:

- several parks per player,
- sharing coaster designs,
- history and undo,
- analytics,
- a leaderboard players can't cheat.

The schema below grows the current tables without throwing them away. It's written as Postgres DDL. SQLite works for
everything except `jsonb`.

```sql
-- Players (unchanged; add a profile row for preferences).
users            (id, provider, provider_id, display_name, avatar_url, created_at, last_login)
user_prefs       (user_id PK → users, camera jsonb, speed int, ui jsonb, updated_at)

-- Parks: several per player. Hot summary columns are copied out of the document.
parks            (id uuid PK, owner_id → users, name, seed bigint, save_version int,
                  settings jsonb,             -- copied out so queries can filter by difficulty, climate, …
                  cash numeric, value numeric, rating int, safety int, day int, guests int,
                  revision int NOT NULL,      -- optimistic concurrency (see below)
                  created_at, updated_at, deleted_at)
park_documents   (park_id PK → parks, data jsonb or bytea (gzip), size_bytes int, updated_at)

-- Point-in-time snapshots: undo, "load yesterday", support, and recovering from a bad client.
park_snapshots   (id, park_id → parks, revision int, day int, reason text,  -- 'daily', 'pre-new-game', 'manual'
                  data bytea (gzip), created_at)

-- Coaster designs: replaces localStorage and enables sharing.
coaster_designs  (id uuid PK, author_id → users, name, pieces jsonb, cars int, color, train_color,
                  cost int, excitement real, intensity real, nausea real, max_speed int,  -- from coaster.simulate()
                  code text UNIQUE,           -- the RCM1: code, for paste/import
                  visibility text,            -- 'private' | 'unlisted' | 'public'
                  downloads int, created_at)
design_likes     (design_id, user_id, created_at, PK(design_id, user_id))

-- Player-made difficulty presets (a SETTINGS_SCHEMA object).
settings_presets (id, owner_id → users, name, settings jsonb, visibility, created_at)

-- Achievements across parks (objectives today are per park, in the document).
achievements     (user_id, objective_id, park_id, achieved_at, PK(user_id, objective_id))

-- Optional analytics (append-only; fine to sample).
park_events      (id, park_id, day, kind text,  -- 'incident', 'event', 'raid', 'fallen', 'execution', …
                  payload jsonb, created_at)
```

Notes on the proposal:

- **Keep the document.** The sim's natural unit is the whole park. Splitting guests into rows would make every save thousands of writes for no gain. Copy out only what you query: summaries, settings, designs and logs.
- **Concurrency.** Two tabs saving the same park today means last-write-wins. Add `revision`: the client sends `If-Match: <revision>`, and the server updates `WHERE revision = $1` and returns 409 on conflict.
- **Compression.** gzip the document (about 400 KB down to 50–80 KB for a full park). In Postgres, `jsonb` with TOAST compression is enough until parks grow much larger.
- **Leaderboard.** Read `parks.value` from a materialized view, refreshed every few minutes, or from an indexed query.
- **Cheating.** The client runs the sim, so a determined player can still edit `cash`. The simulation is deterministic, given `seed`, `rngState` and the step size. A cheat-proof leaderboard can store an **action log** (`park_actions(park_id, seq, game_time, action jsonb)`: build, price, hire, sentence…) and replay it on the server, or spot-check it, before accepting a score. Custom coaster stats are already recomputed on the server.
- **Endpoints to add:**
  - `GET/POST /api/parks`, `GET/PUT/DELETE /api/parks/:id` (multi-slot)
  - `GET /api/parks/:id/snapshots`, `POST /api/parks/:id/restore`
  - `GET/POST /api/designs`, `GET /api/designs/:code`, `POST /api/designs/:id/like`
  - `GET/POST /api/presets`
- **Migration path from today:** `parks(user_id …)` becomes `parks(id, owner_id …)` with one row per existing user. `data` moves to `park_documents`. The browser's `rcm.designs` list is uploaded once on first login after the change. `/api/park` is kept as an alias for "the player's most recent park".

## Checklist for new persistent features

1. **Is it config, state, log or churn?** Put it in the matching place in the document, or in its own table if other players need to see it.
2. **Default** in `createPark()` and `createEmpty()`. **Validate** in `deserialize()`: clamp numbers, allow-list enums, cap array lengths, check `#rrggbb` colours.
3. **Transient?** Prefix it with `_` so `serialize()` drops it.
4. **Test it** by saving and reloading in `tests/`. If it's an option, regenerate `docs/CUSTOMIZATION.md` with `npm run docs`.
