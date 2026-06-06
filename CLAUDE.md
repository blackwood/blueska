# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Blueska** - a Bluesky feed generator for ska music and related subgenres. Subscribes to the Bluesky firehose, indexes ska-related posts, tracks engagement (likes), and serves a feed that interleaves fresh and popular content.

## Commands

```bash
yarn start           # Run server via ts-node (dev, port 3000 or FEEDGEN_PORT)
yarn build           # Compile TypeScript to dist/
yarn publishFeed     # Interactive CLI to publish feed to Bluesky
yarn unpublishFeed   # Unpublish a feed
```

**Requirements:** Node >= 18, Yarn 1 (enforced via `engines` in package.json)

## Architecture

### Data Flow
1. Server connects to Bluesky firehose (`wss://bsky.network`)
2. `FirehoseSubscription` receives and filters repository events
3. Matching posts stored in SQLite via Kysely; likes increment `likeCount` in-place
4. Clients request feeds via `getFeedSkeleton` XRPC endpoint
5. Algorithm queries database and returns post URIs (client's PDS hydrates full posts)

### Key Components

- **`src/index.ts`** - Entry point: loads `.env`, resolves `serviceDid` (`did:web:<hostname>` unless `FEEDGEN_SERVICE_DID` overrides), starts server
- **`src/server.ts`** - `FeedGenerator` class: Express app, database, firehose subscription, XRPC server
- **`src/config.ts`** - `AppContext` and `Config` types (not env parsing — that happens in `src/index.ts`)
- **`src/subscription.ts`** - `FirehoseSubscription.handleEvent()`: main filtering logic + like tracking
- **`src/algos/blueska.ts`** - Feed algorithm; registered in `src/algos/index.ts`
- **`src/methods/feed-generation.ts`** - `getFeedSkeleton` XRPC handler
- **`src/methods/describe-generator.ts`** - `describeFeedGenerator` XRPC handler
- **`src/db/schema.ts`** - Kysely table types (`Post`, `SubState`)
- **`src/db/migrations.ts`** - Migrations 001 (create tables) and 002 (add `likeCount`)
- **`src/auth.ts`** - JWT validation for user requests
- **`src/well-known.ts`** - `/.well-known/did.json` for did:web
- **`src/util/subscription.ts`** - `FirehoseSubscriptionBase`, `getOpsByType()` helper
- **`src/lexicon/`** - Auto-generated atproto lexicon types — do not edit manually

### Extension Points

1. **Add algorithms** - Create handler in `src/algos/`, register in `src/algos/index.ts`
2. **Modify filtering** - Edit `isSkaRelated()` and pattern arrays in `src/subscription.ts`
3. **Add database tables** - Add migrations in `src/db/migrations.ts` and types in `src/db/schema.ts`

### Environment Variables

All variables (`.env.example` is authoritative):

| Variable | Default | Notes |
|---|---|---|
| `FEEDGEN_PORT` | `3000` | Server listen port |
| `FEEDGEN_LISTENHOST` | `localhost` | Bind address; use `0.0.0.0` in Docker |
| `FEEDGEN_SQLITE_LOCATION` | `:memory:` | Path to SQLite file; use `/data/blueska.db` in Docker |
| `FEEDGEN_SUBSCRIPTION_ENDPOINT` | `wss://bsky.network` | Firehose URL |
| `FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY` | `3000` | Reconnect delay in ms |
| `FEEDGEN_HOSTNAME` | `example.com` | Public hostname; used to build `did:web` |
| `FEEDGEN_PUBLISHER_DID` | — | DID of the Bluesky account that publishes the feed |
| `FEEDGEN_SERVICE_DID` | `did:web:<HOSTNAME>` | Override service DID (optional) |

## Hosting / Deployment

### Docker (recommended for production)

The repo ships a multi-stage `Dockerfile` and a `docker-compose.yml` that runs two services:

- **`blueska`** — the Node app built from source; data persisted at `/data/blueska.db` in a named volume (`blueska-data`); exposes port 3000 internally only
- **`caddy`** — Caddy 2 reverse proxy (`caddy:2-alpine`); terminates TLS automatically; proxies to `blueska:3000`; configured via `Caddyfile`

**`Caddyfile`** (minimal — Caddy handles HTTPS automatically):
```
{$FEEDGEN_HOSTNAME} {
    reverse_proxy blueska:3000
}
```

**Required `.env` for `docker-compose up`:**
```
FEEDGEN_HOSTNAME=your.domain.com
FEEDGEN_PUBLISHER_DID=did:plc:...
```

**Start:**
```bash
docker compose up -d
```

**`.dockerignore`** excludes: `node_modules`, `dist`, `*.db`, `.env`, `.git`, `scripts`, `README.md`, `CLAUDE.md`

### Local / Dev

`yarn start` runs via `ts-node` — no build step required. The server binds to `localhost:3000` by default. Use a persistent SQLite path (`FEEDGEN_SQLITE_LOCATION=blueska.db`) to retain data across restarts.

### DID / Identity

- Default identity method: `did:web:<FEEDGEN_HOSTNAME>` served at `/.well-known/did.json`
- Override with `FEEDGEN_SERVICE_DID` if using a `did:plc` identity instead

## Code Patterns

- Algorithm names max 15 characters (Bluesky XRPC constraint)
- Cursor-based pagination: `blueska` algorithm encodes state as page number string
- `getOpsByType()` categorizes firehose ops into `posts.creates`, `posts.deletes`, `likes.creates`, `likes.deletes`, `reposts`, `follows`

### SQLite / event-loop constraint

`better-sqlite3` is **synchronous** — every query blocks the Node.js event loop for its entire duration. Because the firehose consumer and HTTP server share one process, any long-running query starves HTTP serving, causing health checks to time out and `/.well-known/did.json` to become unreachable (which Bluesky surfaces as "could not resolve identity").

Rules that follow from this:

- **Never run a bulk operation without batching.** Any `DELETE`, `UPDATE`, or `CREATE INDEX` touching more than a few thousand rows must be done in batches of ~500 with `await new Promise(resolve => setImmediate(resolve))` between iterations to yield the event loop.
- **Never put a long migration in `migrateToLatest`.** Schema-only migrations (CREATE TABLE, ALTER TABLE, CREATE INDEX on an empty/small table) are fine. Data-cleanup migrations on large tables will freeze the server during startup. Prefer running bulk cleanup in the background retention job instead.
- **The HTTP server must bind before `migrateToLatest` is called** (`src/server.ts:start()`) so health checks can respond during migration. Even so, a long synchronous migration will freeze the event loop after binding — avoid them.
- **The retention job uses `setTimeout(prune, 90_000)` for the first run** to ensure the deploy is confirmed healthy before any cleanup begins.
- Long-term fix: move to a worker-thread-based SQLite driver (e.g. `@databases/sqlite`) or split the firehose consumer into a separate process with its own DB connection.

## Ska Keyword Matching

Filtering in `src/subscription.ts` uses three tiers:

**High-confidence** (always match, no context needed):
- Compound terms: `ska-punk`, `ska-core`, `third wave ska`, `rocksteady`, `skanking`, `rudeboy`, `rudegirl`, `2-tone ska`
- Hashtag: `#ska`
- Notable bands: The Specials, Selecter, Skatalites, Madness, Operation Ivy, Less Than Jake, Streetlight Manifesto, Reel Big Fish, Mighty Mighty Bosstones, Save Ferris, Goldfinger, Toots & the Maytals, Desmond Dekker, Bad Manners, The Beat (when paired with `ska`)

**Ambiguous — require music context** (`band`, `gig`, `vinyl`, `horns`, `upstroke`, etc.):
- Standalone `ska` (also filtered for Swedish grammar patterns)
- `two-tone` / `rude boy/girl`

**Excluded:**
- Swedish `ska` (auxiliary verb): detected via subject pronouns + common verb infinitives
- `polska` (Polish dance / "Polish" in Swedish)

## Feed Algorithm (`src/algos/blueska.ts`)

Interleaves fresh and popular posts in a 3:1 ratio:
- **Fresh**: posts from last 48 hours, ordered by `indexedAt` DESC
- **Popular**: posts with `likeCount > 0`, ordered by `likeCount` DESC then `indexedAt` DESC
- Deduplicates posts that appear in both buckets
- Cursor encodes `freshOffset:popularOffset` for stable pagination across pages
