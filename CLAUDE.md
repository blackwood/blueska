# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Blueska** — a Bluesky feed generator for ska music and related subgenres. Subscribes to the Bluesky Jetstream firehose, indexes ska-related posts, tracks engagement (likes), and serves a ranked feed that combines freshness, engagement, author scene-graph proximity, and lexicon relevance.

## Commands

```bash
yarn start              # Run server via ts-node (dev, port 3000 or FEEDGEN_PORT)
yarn build              # Compile TypeScript to dist/
yarn publishFeed        # Interactive CLI to publish feed to Bluesky
yarn unpublishFeed      # Unpublish a feed

# Feed quality tools
yarn inspectPost <url>  # Fetch post text + lexicon score for a bsky.app URL or AT-URI
yarn previewFeed        # Rank current DB contents and print top N posts with score breakdown
yarn analyzeExamples    # Score all labeled URIs in data/examples.json; report misclassifications
yarn checkHealth        # Smoke-test prod (HTTP checks + optional DB checks); exit 1 on failures
                        # --local: target localhost instead of prod hostname
                        # DB checks run automatically if FEEDGEN_SQLITE_LOCATION is a real file

# Scene graph
yarn crawlSceneGraph    # Crawl seed follows, write author_score to local DB
yarn syncSceneGraph     # Full prod workflow: crawl → push to Fly DB → restart machine
```

**Requirements:** Node >= 18, Yarn 1 (enforced via `engines` in package.json)

## Architecture

### Data Flow
1. Server connects to Bluesky Jetstream (`wss://jetstream2.us-east.bsky.network/subscribe`)
2. `FirehoseSubscription` receives commit events and filters posts
3. Posts that pass `isSkaRelated()` or the author-affinity gate are stored in SQLite via Kysely
4. Likes on indexed posts increment `likeCount` in-place; all other likes are ignored
5. Feed algorithm queries DB, scores candidates with composite formula, and returns ranked post URIs
6. Client's PDS hydrates full post content

### Key Components

- **`src/index.ts`** — Entry point: loads `.env`, resolves `serviceDid`, starts server
- **`src/server.ts`** — `FeedGenerator`: Express app, SQLite DB, Jetstream subscription, retention job, author affinity loader
- **`src/config.ts`** — `AppContext` and `Config` types
- **`src/subscription.ts`** — Main filtering logic: `isSkaRelated()`, `nearMissReason()`, like tracking, author affinity gate
- **`src/algos/blueska.ts`** — Composite scoring algorithm: `author × 0.40 + freshness × 0.30 + engagement × 0.20 + lexicon × 0.10`; per-author cap of 3 posts per page
- **`src/methods/feed-generation.ts`** — `getFeedSkeleton` XRPC handler
- **`src/methods/health.ts`** — `GET /health`: firehose lag + DB size; no DB query (uses in-memory `lastEventAt`)
- **`src/db/schema.ts`** — Kysely table types: `Post`, `SubState`, `Like`, `AuthorScore`
- **`src/db/migrations.ts`** — Migrations 001–010 (schema only — no bulk data ops; see SQLite constraint below)
- **`src/util/jetstream.ts`** — `JetstreamSubscriptionBase`: WebSocket client, cursor persistence, `lastEventAt`
- **`src/util/lexiconScore.ts`** — `computeLexiconScore(text)`: exp-curve weighted term scorer; `LEXICON_SCORE_VERSION` constant
- **`src/auth.ts`** — JWT validation
- **`src/well-known.ts`** — `/.well-known/did.json` for did:web
- **`src/lexicon/`** — Auto-generated atproto lexicon types — do not edit manually

### Scripts

- **`scripts/crawlSceneGraph.ts`** — Resolves seed handles → fetches follows → scores candidates by fraction of seeds that follow them; writes to `author_score` table
- **`scripts/inspectPost.ts`** — Takes a bsky.app URL or AT-URI; prints text + lexicon score + gate result
- **`scripts/previewFeed.ts`** — Simulates the feed algorithm against the local DB; fetches post text; prints ranked list with per-component score breakdown and inclusion reason
- **`scripts/analyzeExamples.ts`** — Scores all URIs in `data/examples.json`; reports per-category distributions and misclassifications (false positives / false negatives)
- **`scripts/sync-author-scores.sh`** — Shell wrapper: crawl → export SQL → pipe to prod DB → restart Fly machine

### Data Files

- **`data/examples.json`** — Labeled post URIs for feed quality analysis. Categories: positive (`gig`, `listener`, `promo`, `media`, `humor`) and negative (`swedish`, `crypto`, `geography`, `unrelated`). Feed via `yarn inspectPost`, analyze via `yarn analyzeExamples`.

### Extension Points

1. **Add algorithms** — Create handler in `src/algos/`, register in `src/algos/index.ts`
2. **Modify filtering** — Edit `isSkaRelated()` and pattern arrays in `src/subscription.ts`
3. **Add database tables** — Add migration in `src/db/migrations.ts` and type in `src/db/schema.ts`
4. **Add seeds** — Edit `SEED_HANDLES` in `scripts/crawlSceneGraph.ts`, then run `yarn syncSceneGraph`

### Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `FEEDGEN_PORT` | `3000` | Server listen port |
| `FEEDGEN_LISTENHOST` | `localhost` | Bind address; use `0.0.0.0` in Docker |
| `FEEDGEN_SQLITE_LOCATION` | `:memory:` | Path to SQLite file; use `/data/blueska.db` in Docker |
| `FEEDGEN_SUBSCRIPTION_ENDPOINT` | Jetstream URL | Jetstream WebSocket endpoint |
| `FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY` | `3000` | Reconnect delay in ms |
| `FEEDGEN_HOSTNAME` | `example.com` | Public hostname; used to build `did:web` |
| `FEEDGEN_PUBLISHER_DID` | — | DID of the Bluesky account that publishes the feed |
| `FEEDGEN_SERVICE_DID` | `did:web:<HOSTNAME>` | Override service DID (optional) |

## Hosting / Deployment

Deployed on Fly.io. The `scripts/` directory is excluded from the Docker image (see `.dockerignore`), so scripts cannot be run via `fly ssh console`.

### Full deploy checklist

Run these in order — the ordering constraint matters (see note below).

```bash
# 1. Verify locally
yarn build && yarn test

# 2. Deploy code first — runs DB migrations on startup
fly deploy

# 3. Verify the new deploy is healthy before touching data
yarn checkHealth

# 4. Sync scene graph (crawl locally → push SQL → restart machine)
#    Run after any change to SEED_HANDLES, data/account-tiers.json, or monthly
yarn syncSceneGraph

# 5. Confirm affinity scores loaded + full smoke test with DB
fly sftp get /data/blueska.db /tmp/blueska-local.db
FEEDGEN_SQLITE_LOCATION=/tmp/blueska-local.db yarn checkHealth
```

**Ordering constraint:** `fly deploy` must run before `yarn syncSceneGraph`. The sync script INSERTs with the `tier` column; if a migration that adds that column hasn't run yet on prod, the INSERT fails. Migrations run automatically at startup during `fly deploy`.

**After bumping `LEXICON_SCORE_VERSION`:** existing posts in prod keep their old `lexiconScore` until they age out of the 48 h feed window (~2 days for full turnover). No manual reindex needed.

**Blocked accounts:** add handles to `data/account-tiers.json` under `"blocked"`, then run `yarn syncSceneGraph`. No deploy needed — the server checks the in-memory tier map loaded at startup (triggered by the machine restart inside `syncSceneGraph`).

**Check feed health:**
```bash
yarn checkHealth                                        # HTTP checks only
fly logs | grep '"nearMiss":true'                       # sample of rejected near-misses
```

**Pull prod DB for deep inspection:**
```bash
fly sftp get /data/blueska.db /tmp/blueska-local.db
FEEDGEN_SQLITE_LOCATION=/tmp/blueska-local.db yarn checkHealth   # HTTP + DB checks
FEEDGEN_SQLITE_LOCATION=/tmp/blueska-local.db yarn previewFeed   # ranked feed preview
```

## SQLite / Event-Loop Constraint

`better-sqlite3` is **synchronous** — every query blocks the Node.js event loop. The firehose consumer and HTTP server share one process, so long queries starve HTTP serving and cause health-check timeouts.

Rules:

- **Never run a bulk operation without batching.** Any `DELETE`, `UPDATE`, or `CREATE INDEX` touching more than a few thousand rows must be done in batches of ~500 with `await new Promise(resolve => setImmediate(resolve))` between iterations.
- **Never put bulk data ops in a migration.** Schema-only ops (CREATE TABLE, ALTER TABLE, CREATE INDEX on a small/empty table) are fine. Data cleanup belongs in the background retention job.
- **HTTP server must bind before `migrateToLatest`** (`src/server.ts:start()`) so health checks respond during startup.
- **Retention job uses `setTimeout(prune, 90_000)` for first run** to let the deploy confirm healthy before any SQLite work begins.

## Ska Keyword Matching

Filtering in `src/subscription.ts` uses three tiers:

**High-confidence** (always match, no context needed):
- Compound terms: `ska-punk`, `ska-core`, `third wave ska`, `skanking`
- Hashtags: `#ska`, `#blueska`
- Ska event/form compounds: `ska show`, `ska gig`, `ska concert`, `ska cover`, `ska version`, `ska remix`, etc.
- Unambiguous artists: Skatalites, Operation Ivy, Less Than Jake, Streetlight Manifesto, Reel Big Fish, Mighty Mighty Bosstones, Toots & the Maytals, Desmond Dekker
- Ska identity terms: `rudeboy`, `rudegirl`, `2-tone ska`

**Ambiguous — require music context** (`band`, `gig`, `vinyl`, `horns`, `upstroke`, etc.):
- `ska` standalone (also filtered for Nordic grammar patterns)
- `two-tone` / `rude boy/girl` standalone
- Band names that are common words: The Specials, Selecter, Madness, Save Ferris, Goldfinger, Bad Manners, Rocksteady (hyphenated/closed only — "rock steady" space form excluded)

**Reply gate:** Reply posts (have a `reply` field) only pass if they match a HIGH_CONFIDENCE pattern. The looser standalone-ska + music-context gate does not apply to replies.

**Structural spam gate:** `isMentionSpam()` fires before all semantic checks. Posts with ≥3 @mentions where mentions+hashtags are ≥60% of all tokens are dropped.

**Exclusions** (checked before ambiguous tests):
- Nordic `ska` (Swedish/Norwegian auxiliary verb): subject pronouns + verb infinitives + directional particles (`ska fram`, `ska dit`, `ska hem`, etc.)
- Slavic feminine surnames (`Jasińska` etc.): non-ASCII consonants create false `\b` before "ska"; caught by Unicode lookbehind `/(?<=\p{L})\bska\b/u`
- `polska`, `$ska`, crypto token patterns, geographic names (alaska, nebraska, itasca)
- Madness: structural classifier (`classifyMadness()`) scores by flanking capitalized proper nouns — passes standalone "Madness" (the band), rejects "March Madness", "Sound of Madness", "Midnight Madness", etc.
- Bond film context: `james bond` / `bond film` / `bond movie` without music context; Goldfinger + bond-specific terms (007, villain, etc.) without music context
- Rocksteady Studios / Batman Arkham games: `\barkham\b`, `\bRocksteady Studios\b`
- TMNT characters: `bebop` + `rocksteady`/`rock-steady`/`rock steady` in either order
- Derogatory skanks+skanking co-occurrence (checked before HIGH_CONFIDENCE so it isn't bypassed)

**Author affinity gate:** Posts from authors with `author_score ≥ 0.5` bypass the keyword gate (exclusions still apply). `inclusionReason` stores the tier: `full`, `posts_only`, or `metered`. See account tiers below.

**Account tiers** (`data/account-tiers.json`, applied by `yarn syncSceneGraph`):
- `full` — root posts + replies indexed (default for all seeds)
- `gate_only` — scored for ranking but always goes through the keyword gate; use for scene-adjacent accounts with mixed/noisy content (e.g. music journalists who also post film reviews)
- `posts_only` — root posts bypass gate; replies still need keyword gate
- `metered` — root posts only; feed algorithm applies 1-per-page cap + like threshold
- `blocked` — hard-excluded before any gate logic; add handles here for slop/spam accounts

**Near-miss logging:** 10% of rejected posts that had some ska-adjacent signal are logged as JSON to stdout with a `reason` tag (`ambiguous:no_context`, `ska:nordic`, `exclude:ambiguous_band`, `reply:ska`, etc.). Query: `fly logs | grep '"nearMiss":true'`.

## Feed Algorithm (`src/algos/blueska.ts`)

Composite score: `0.40 × authorScene + 0.30 × freshness + 0.20 × engagement + 0.10 × lexicon`

- **authorScene**: `author_score` from scene graph (0 if not in graph; 1.0 for seeds). Empty until `yarn syncSceneGraph` is run.
- **freshness**: `exp(-ageMs / 48h)` — decays over 48-hour window
- **engagement**: `min(1, log1p(likeCount) / log(10))` — log-normalised like count
- **lexicon**: `computeLexiconScore(text)` — exp-curve weighted term match, see `src/util/lexiconScore.ts`

Per-author cap: max 3 posts per page (default). `metered` accounts are capped at 1 per page and require `likeCount ≥ 1` to surface at all.

Cursor encodes page number (0-indexed) for stable pagination.

## Lexicon Scoring (`src/util/lexiconScore.ts`)

`computeLexiconScore(text): number` — returns 0–1 using `1 - exp(-sum / K)` where K=1.5.

- **Tier 1** (weights 0.85–1.0): mirrors HIGH_CONFIDENCE_PATTERNS — skanking, #ska, ska-punk, unambiguous artists
- **Tier 2** (weights 0.45–0.55): mirrors AMBIGUOUS_BAND_PATTERNS — Madness, Goldfinger, Rocksteady, etc.
- **Tier 3** (weights 0.15–0.30): genre-adjacent signals — reggae, upstroke, offbeat, trombone, checkerboard, etc.

Bump `LEXICON_SCORE_VERSION` when the vocabulary changes. Stale posts can be identified with `WHERE scoreVersion < LEXICON_SCORE_VERSION`.

## Scene Graph (`scripts/crawlSceneGraph.ts`)

Scores Bluesky accounts by social proximity to known ska scene seeds:
- Seeds get `score = 1.0`
- Candidates get `score = (seeds_that_follow_them / total_seeds)`
- Minimum threshold: `score ≥ 0.05` (followed by ≥5% of seeds)

Results written to `author_score` table. Server loads them into memory via `loadAuthorAffinity()` on startup. Re-run whenever seeds change or monthly to keep scores fresh.

**Add a seed:** Edit `SEED_HANDLES` in `scripts/crawlSceneGraph.ts`, then run `yarn syncSceneGraph`.

**Add a blocked account:** Add the handle to `data/account-tiers.json` under `"blocked"`, then run `yarn syncSceneGraph` (no deploy needed — machine restart reloads the in-memory map).

**Current scale (2026-06-22):** 39 seeds, 704 author scores written to prod.

## Feed Quality Workflow

### Investigate a post
```bash
yarn inspectPost https://bsky.app/profile/<handle>/post/<rkey>
```
Outputs: AT-URI, post text, lexicon score.

### Add a labeled example
Add the AT-URI from `inspectPost` to the correct category in `data/examples.json`:
- Positive: `gig`, `listener`, `promo`, `media`, `humor`
- Negative: `swedish`, `crypto`, `geography`, `unrelated`

### Analyze the labeled set
```bash
yarn analyzeExamples
```
Prints per-category score distributions, gate pass rates, and any misclassifications (positives that fail the gate, negatives that pass it).

### Preview the feed
```bash
# Pull prod DB first
fly sftp get /data/blueska.db /tmp/blueska-local.db

# Preview (fetches post text by default)
FEEDGEN_SQLITE_LOCATION=/tmp/blueska-local.db yarn previewFeed --limit=20

# Skip text fetch for speed
FEEDGEN_SQLITE_LOCATION=/tmp/blueska-local.db yarn previewFeed --no-fetch
```

### Monitor near-misses (posts that nearly passed the gate)
```bash
fly logs | grep '"nearMiss":true'
fly logs | grep 'ambiguous:no_context'   # band matched, no music context
fly logs | grep 'exclude:ambiguous_band' # exclusion fired on a band name
```
AT-URIs in near-miss logs can be fed directly to `yarn inspectPost` or added to `data/examples.json`.
