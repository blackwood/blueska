# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Blueska** - a Bluesky feed generator for ska music and related subgenres. Subscribes to the Bluesky firehose, indexes ska-related posts, tracks engagement (likes), and serves a feed that interleaves fresh and popular content.

## Commands

```bash
yarn start           # Run server (port 3000 or FEEDGEN_PORT)
yarn build           # Compile TypeScript to dist/
yarn publishFeed     # Interactive CLI to publish feed to Bluesky
yarn unpublishFeed   # Unpublish a feed
```

**Requirements:** Node >= 18, Yarn 1 (enforced)

## Architecture

### Data Flow
1. Server connects to Bluesky firehose (`wss://bsky.network`)
2. `FirehoseSubscription` receives and filters repository events
3. Matching posts stored in SQLite via Kysely
4. Clients request feeds via `getFeedSkeleton` XRPC endpoint
5. Algorithm queries database and returns post URIs (client's PDS hydrates full posts)

### Key Components

- **`src/index.ts`** - Entry point, loads env and starts server
- **`src/server.ts`** - `FeedGenerator` class: Express app, database, firehose subscription, XRPC server
- **`src/config.ts`** - Configuration from environment variables
- **`src/subscription.ts`** - `FirehoseSubscription.handleEvent()` processes firehose events (main filtering logic)
- **`src/algos/`** - Algorithm handlers, each returns `AlgoOutput` with post URIs and cursor
- **`src/methods/`** - XRPC route handlers (`getFeedSkeleton`, `describeFeedGenerator`)
- **`src/db/`** - Kysely database schema and migrations (tables: `post`, `sub_state`)
- **`src/auth.ts`** - JWT validation for user requests
- **`src/well-known.ts`** - `/.well-known/did.json` for did:web

### Extension Points

1. **Add algorithms** - Create handler in `src/algos/`, register in `src/algos/index.ts`
2. **Modify filtering** - Edit `handleEvent()` in `src/subscription.ts`
3. **Add database tables** - Add migrations in `src/db/migrations.ts`

### Environment Variables

Key variables (see `.env.example` for full list):
- `FEEDGEN_PORT` - Server port (default: 3000)
- `FEEDGEN_SQLITE_LOCATION` - Database path (default: in-memory)
- `FEEDGEN_SUBSCRIPTION_ENDPOINT` - Firehose URL
- `FEEDGEN_HOSTNAME` - Service hostname for DID
- `FEEDGEN_PUBLISHER_DID` - Account DID for publishing feeds

## Code Patterns

- Algorithm names max 15 characters
- Cursor-based pagination for feeds
- `getOpsByType()` helper categorizes firehose operations (posts, reposts, likes, follows)
- Lexicon types in `src/lexicon/` are auto-generated - do not edit manually

## Ska Keyword Matching

Posts are indexed if they match patterns in `src/subscription.ts`:
- `ska`, `ska-punk`, `skapunk`
- `2-tone`, `two-tone`, `rocksteady`
- `rude boy`, `rude girl`
- `skank`, `skanking`
- `third wave ska`, `ska-core`

## Feed Algorithm

The `blueska` algorithm (`src/algos/blueska.ts`) interleaves fresh and popular posts:
- Fresh: posts from last 48 hours, sorted by time
- Popular: posts with likes, sorted by like count
- Ratio: ~3 fresh posts per 1 popular post
- Deduplicates overlapping posts
