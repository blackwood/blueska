# Blueska

A Bluesky feed generator for ska music and related subgenres (ska-punk, rocksteady, 2-tone, reggae-adjacent). Live at **[blueska.fly.dev](https://blueska.fly.dev)**.

Posts are indexed from the Bluesky firehose, filtered by keyword matching and scene graph proximity, and ranked by a composite score of freshness, engagement, author reputation, and lexical relevance.

---

## Day-to-day workflows

### Check what's in the feed

Pull the production database and preview the current ranked feed with post text:

```bash
fly sftp get /data/blueska.db /tmp/blueska-local.db
FEEDGEN_SQLITE_LOCATION=/tmp/blueska-local.db yarn previewFeed --limit=20
```

Each post shows its composite score broken down by component (`auth`, `fresh`, `eng`, `lex`) and how it got in (`[keyword]` or `[affinity]`). Add `--no-fetch` to skip the Bluesky API calls and show URIs only.

---

### Investigate a specific post

```bash
yarn inspectPost https://bsky.app/profile/<handle>/post/<rkey>
```

Prints the AT-URI, post text, and lexicon score. Use this to:
- Check why a post scored high or low
- Get the AT-URI to add to `data/examples.json`
- Verify a false positive or false negative before changing gate rules

---

### Monitor for false negatives (ska posts we're missing)

The server logs a 10% sample of rejected posts that had some ska-adjacent signal:

```bash
fly logs | grep '"nearMiss":true'
```

Filter by rejection reason:

```bash
fly logs | grep 'ambiguous:no_context'    # band name matched but no music context words
fly logs | grep 'exclude:ambiguous_band'  # our exclusion rules blocked something
fly logs | grep 'reply:ska'               # reply posts that would have passed as root posts
fly logs | grep 'ska:nordic'              # possibly Swedish posts we're filtering
```

Each log line contains a `uri` field. Pipe it into `inspectPost` or add it to `data/examples.json`.

---

### Label examples and measure classifier quality

**Add an example:**

1. Find a post via the feed, near-miss logs, or browsing Bluesky
2. Run `yarn inspectPost <url>` to get the AT-URI
3. Add it to `data/examples.json` under the right category:
   - **positive:** `gig` (event post), `listener` (fan reaction), `promo` (band/label promotion), `media` (article/video), `humor` (ska-adjacent joke)
   - **negative:** `swedish` (Nordic false positive), `crypto`, `geography`, `unrelated`

**Analyze the labeled set:**

```bash
yarn analyzeExamples
```

For each category: mean lexicon score, gate pass rate, and any misclassifications (positive posts that fail the gate = false negatives; negative posts that pass = false positives). The score separation between positive and negative means should stay above ~0.2. If it drops, the lexicon vocabulary needs tuning.

---

### Update the scene graph

The scene graph scores Bluesky accounts by how many seed accounts follow them. Seeds (labels, venues, ska bands, podcasts) get score 1.0. Their follows get a score proportional to how many seeds follow them.

**Add a seed account:**

1. Edit `SEED_HANDLES` in `scripts/crawlSceneGraph.ts`
2. Run:

```bash
yarn syncSceneGraph
```

This crawls the graph, pushes the scores to the production database, and restarts the server. The feed's author weight (`0.40`) activates immediately.

**Refresh scores without adding seeds** (monthly or after a big ska event):

```bash
yarn syncSceneGraph
```

---

### Deploy a code change

```bash
fly deploy
```

The server binds HTTP before running migrations, so health checks pass during startup. The retention job waits 90 seconds before its first run, so a fresh deploy is confirmed healthy before any background SQLite work begins.

After deploy, verify with:

```bash
curl https://blueska.fly.dev/health
```

Returns `{"status":"ok","firehoseLagSeconds":N,"dbSizeBytes":N}`. Status is `degraded` if the firehose hasn't sent an event in over 5 minutes.

---

## How the feed works

### Inclusion gate (`src/subscription.ts`)

Posts are indexed if they pass any of:

1. **High-confidence keyword** — `ska-punk`, `#ska`, `skanking`, `Less Than Jake`, Skatalites, etc. No context required.
2. **Ambiguous keyword + music context** — `Madness`, `Goldfinger`, `Rocksteady`, standalone `ska`, etc. must co-occur with a music context word (`band`, `gig`, `vinyl`, `horns`, etc.).
3. **Author affinity** — author has `author_score ≥ 0.5` in the scene graph and the post isn't blocked by an exclusion.

Reply posts only qualify via route 1 (high-confidence) or route 3 (affinity). The looser music-context gate doesn't apply to replies without their parent context.

Hard exclusions block even high-confidence matches: Nordic `ska` grammar, crypto tokens, geographic names (Alaska, Nebraska), `Madness` as part of a compound proper noun (March Madness, Sound of Madness), Rocksteady Studios / Arkham games, TMNT's Bebop & Rocksteady.

### Ranking formula (`src/algos/blueska.ts`)

```
score = 0.40 × authorScene + 0.30 × freshness + 0.20 × engagement + 0.10 × lexicon
```

- **authorScene** — `author_score` from the scene graph (0 for unknown accounts, 1.0 for seeds)
- **freshness** — exponential decay over 48 hours
- **engagement** — log-normalised like count
- **lexicon** — term-matching score from `src/util/lexiconScore.ts`; rewards posts with stronger ska vocabulary

Max 3 posts per author per feed page to prevent prolific accounts flooding.

### Scene graph (`scripts/crawlSceneGraph.ts`)

Seed accounts are manually curated ska labels, bands, venues, and community accounts. The crawl fetches each seed's follows and scores candidates by `(seeds_that_follow_them / total_seeds)`. Anyone followed by ≥5% of seeds gets a score. Run `yarn syncSceneGraph` to refresh.

---

## Scripts reference

| Command | What it does |
|---|---|
| `yarn inspectPost <url>` | Fetch text + lexicon score for any post |
| `yarn previewFeed` | Rank current DB and print top posts with score breakdown |
| `yarn analyzeExamples` | Score labeled examples, report distributions and misclassifications |
| `yarn crawlSceneGraph` | Crawl scene graph into local DB only |
| `yarn syncSceneGraph` | Full prod sync: crawl → push to Fly → restart |
| `yarn start` | Run server locally (dev) |
| `yarn build` | Compile TypeScript |
| `yarn publishFeed` | Publish or update feed metadata on Bluesky |
