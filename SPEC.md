# Blueska — System Specification

**Status:** Draft v2
**Decision:** Run our own feed generator (the existing **Blueska** repo) on owned infrastructure. Graze is, at most, an interim/fallback — not the long-term home.
**Scope:** A Bluesky/ATProto feed surfacing ska music and closely adjacent scenes, biased toward DIY-band and fan content. Covers the disambiguation research, the (interim) Graze design, the target Blueska system grounded in the actual codebase, the firehose decision, hosting, and an ordered branch sequence.

---

## 1. Purpose and scope

Surface posts about ska — trad / 2-tone / third-wave / ska-punk / skacore — and dip into directly adjacent genres (rocksteady, dub, early reggae, mod revival, northern soul, ska-jazz) when a post is clearly music-related. Preferentially capture what the scene actually produces: fans hyping a show, people sharing a record they found, and DIY bands promoting their own gigs/releases.

We are **ejecting from Graze** for the control it can't give us (no author/scene-graph signal, no custom scoring, no real conditional logic). The build path is to **branch from the existing Blueska feed-generator repo** and layer the design on top additively. The Graze design below is preserved as a documented interim/fallback and because its lexical work is already mirrored in the repo.

---

## 2. Research findings (disambiguation)

### 2.1 "ska" is a cross-language homograph

| Language(s) | Why "ska" appears | Collision type |
|---|---|---|
| Swedish, Norwegian | `ska` = everyday verb "shall/will" | Standalone word — hardest case |
| Russian, Ukrainian, Bulgarian, Serbian | `-ска` feminine adjectival/possessive suffix | Word fragment |
| Polish | `-ska` feminine surname/adjective ending (polska) | Word fragment |
| Czech, Slovak | `-ská` adjectival ending (*sebeláska* = "self-love") | Word fragment |
| English | place names (Alaska, Nebraska); crypto ($SKA) | Substring / namespace |

These are **two problems in one costume**:

1. **Lexical fragments** (*sebeláska*, *polska*, *Alaska*): "ska" glued mid-word, no boundary. Fully solved by a word-boundary regex `\bska\b`, which never fires inside a word — cheap, language-agnostic, no lists to maintain.
2. **Standalone homographs** (Swedish *"Vi ska ta hand om varandra"*): "ska" is a clean token, lexically identical to the genre. **Regex cannot solve this** — it sees characters, not meaning. Requires a semantic signal.

### 2.2 Similarity matches *structure*, not just topic

Embedding/text-similarity compares the *shape and register* of text. A seed written as a genre **definition** matches encyclopedia/marketing prose, not the excited first-person posts the scene writes. **Rule:** the seed must be an *exemplar of the target post*. Use one seed per register (they differ structurally):

- **Show/gig** — "just got back from the show and my ears are still ringing, the horn section was so tight, skanked the whole set, best gig in forever"
- **Record/discovery** — "finally found a clean copy of this rocksteady record at the shop today, been hunting for it for years, haven't stopped spinning it"
- **DIY band promo** — "our new EP is up on bandcamp, recorded it in the drummer's garage, pay what you want, and we play friday so come skank with us"

Side benefit: fan-voice seeds also help language disambiguation — a flat Swedish declarative resembles none of these and scores low without any language rule.

### 2.3 English-probability as a free "scene-relevance" proxy

Music is English-loanword-dense ("gig," "show," "band," "live," "EP," "Bandcamp," "tour," "skanking" leak untranslated). So P(English) tracks "is the author in the anglophone music orbit" with no translated word lists. Pure-Swedish "Vi ska ta hand om varandra" (no loanwords) sits at the floor; a real Swedish ska post ("ny ska-låt, spelar live på fredag, så bra gig") is lifted over a low bar by "live"/"gig".

**Rule:** set the language gate as a *low floor* (≈0.15–0.25), never a high ceiling — a high bar rejects the code-switched bilingual posts you want.

**Resolved:** Graze's Language Analysis is confirmed to be *select-a-language + percent-match* (a per-language probability), so the floor IS implementable on Graze if used as an interim. In the owned Blueska system this gets better: run a real language-ID library in-process (see §4.6 / §7), replacing the brittle hand-rolled Swedish heuristic currently in the repo.

### 2.4 Separation of concerns (one job per gate)

- `\bska\b` (boundaried regex) → is the token lexically present?
- P(English) ≥ floor → in the anglophone music orbit?
- Fan-voice similarity / register classifier → the DIY/fan/record register we want?

More robust than overloading one wobbly similarity seed with topic + register + language at once.

---

## 3. Interim option — Graze MVP (reference / fallback)

Documented in case a zero-infra stopgap is wanted before Blueska is live. Skippable if ejecting straight to owned infra.

### 3.1 Node tree

```
ALL OF THESE
├─ ANY OF THESE          ← topic: word list (genre) / word list (subgenre) / regex \bska\b
├─ Language Analysis     ← P(English) ≥ ~0.20  (per-language %, confirmed)
├─ ANY OF THESE          ← register: text-similarity seeds 1/2/3 (§2.2)
├─ Word List (MISSING)   ← exclusions
└─ Regex (MISSING)       ← \$SKA\w*\b
```

`ALL OF THESE` is AND — ordering is cosmetic. The language floor and exclusions are always-true gates, so they are direct AND-level children, never nested inside an `ANY OF THESE` (nesting the floor would make it optional and break it).

### 3.2 Node contents

- **Word List — ska core (contains, case-insensitive):** ska, skacore, ska punk, ska-punk, 2 tone, 2-tone, two tone, rocksteady, rude boy, rude girl, skanking, ska revival, third wave ska, trad ska, skinhead reggae, ska band, ska-låt, ska jazz.
- **Word List — adjacent (contains, case-insensitive):** rocksteady, reggae ska, ska reggae, dub, mod revival, northern soul, latin ska, calypso, early reggae, dancehall, trojan records, two tone records.
- **Regex — token presence:** `\bska\b`, **case-insensitive** (plain regex is case-sensitive by default and would miss "Ska"/"SKA"; do NOT add a separate `\bSKA\b` rule — it misses title-case. Use the node toggle, else `(?i)\bska\b`, else `\b[Ss][Kk][Aa]\b`). Correctly still fires on "ska-låt", "ska!".
- **Text Similarity ×3:** §2.2 seeds; start each ≈0.35–0.40 (OR'd, narrow), tune in debugger.
- **Language Analysis:** include if P(English) ≥ ≈0.20.
- **Word List — exclusions (MISSING):** Alaska, Nebraska, Itaska, Kaska, polska, $SKA, ska coin, ska token, ska crypto, ska airdrop.
- **Regex — exclusions (MISSING):** `\$SKA\w*\b`.

### 3.3 Tuning / tradeoffs

Use the post-debugger; target a visible gap (false friends near the floor and below similarity; real posts above both). Watch gate-stacking — every AND child only subtracts, and AI nodes are imperfect, so failures compound; start with topic + language + register only. Accepted: dry news/review posts drop (consistent with content goal); flawless loanword-free Swedish ska posts drop (rare). Both are deliberate precision-over-recall calls.

---

## 4. Target system — Blueska feed generator

### 4.1 Reframe

Graze (and the repo's current state) is a *per-post boolean membership test*. The target is a **streaming retrieval-and-ranking system with an author-graph prior**. Highest-leverage idea: **ska is a scene made of accounts, not posts.** Knowing *who* is in the scene gives most good posts a strong prior before any text is read — and recovers the foreign-language recall the English floor sacrifices (a Swedish ska band's account is in-cluster, so its Swedish posts pass on author signal).

### 4.2 Current codebase (what exists)

Blueska is a customized fork of the official `bluesky-social/feed-generator` starter. TypeScript; **Node ≥ 18, Yarn 1**. Data flow: connect to firehose → `FirehoseSubscription` filters repo events → matching posts stored in **SQLite via Kysely**, likes increment `likeCount` in place → clients call `getFeedSkeleton` → algorithm returns post URIs (client PDS hydrates).

Key files:

| File | Role |
|---|---|
| `src/index.ts` | Entry; loads `.env`, resolves `serviceDid` (`did:web:<hostname>` unless overridden) |
| `src/server.ts` | `FeedGenerator`: Express + DB + firehose subscription + XRPC (one process) |
| `src/subscription.ts` | `handleEvent()`: filtering (`isSkaRelated`) + like tracking |
| `src/algos/blueska.ts` | Feed algorithm; registered in `src/algos/index.ts` |
| `src/methods/feed-generation.ts` | `getFeedSkeleton` handler |
| `src/db/schema.ts`, `src/db/migrations.ts` | Kysely types; migrations 001 (tables), 002 (`likeCount`) |
| `src/util/subscription.ts` | `FirehoseSubscriptionBase`, `getOpsByType()` |
| `src/lexicon/` | Auto-generated — do not edit |

Env (`.env.example` authoritative): `FEEDGEN_PORT` (3000), `FEEDGEN_LISTENHOST` (localhost; `0.0.0.0` in containers), `FEEDGEN_SQLITE_LOCATION` (`:memory:`; use a file path to persist), `FEEDGEN_SUBSCRIPTION_ENDPOINT` (`wss://bsky.network`), `FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY` (3000), `FEEDGEN_HOSTNAME` (builds `did:web`), `FEEDGEN_PUBLISHER_DID`, `FEEDGEN_SERVICE_DID` (optional override).

Already aligned with the design: tiered keyword matcher with **Swedish-verb exclusion and `polska` exclusion already implemented** (our §2.1 hardest cases, in code); `likeCount` engagement signal; fresh/popular **3:1 interleave** (fresh = last 48h by `indexedAt` DESC; popular = `likeCount > 0` by `likeCount` then `indexedAt`; deduped; cursor `freshOffset:popularOffset`); Dockerized with a Caddy reverse proxy; `did:web` via `/.well-known/did.json`. Constraints to remember: algorithm names ≤ 15 chars; `getOpsByType()` already splits posts/likes/reposts/follows.

### 4.3 Gaps vs design (leverage order)

1. **Author/scene-graph prior — absent.** The repo is still pure per-post keyword matching, like Graze. This is the main justification for ejecting. Additive: new table + standalone crawler + a score lookup/boost in `blueska.ts`.
2. **Semantic/register classifier — absent.** Matching is regex tiers; no fan-hype/band-promo/record-share distinction; Swedish handling is brittle hand-rolled heuristics (replace per §4.6).
3. **Weighted scoring — partial.** Only fresh/popular interleave; membership still boolean-keyword. Move to a continuous relevance score (author + engagement + recency + register).
4. **Multimodal/link signals + feedback loop — absent.**

**Quick win — like-decrement gap.** Unlike deletes carry only the like record's URI, not its subject, so `likeCount` can't decrement. Fix: store likes in a table keyed by like URI with the subject URI on create; resolve the subject on delete and decrement. Cheap, and it protects the engagement signal everything downstream builds on.

### 4.4 Pipeline (target)

1. **Candidate generation (cheap, high-recall).** Firehose → lexical prefilter (`\bska\b` + genre/adjacency). Sloppy precision OK; don't drop true positives.
2. **Author/scene-graph prior** (§4.5). In-scene authors clear a low text bar; unknowns clear a higher one.
3. **Multimodal signals.** Resolve links (Bandcamp/Spotify/Songkick beside "ska" ≈ certain; Bandcamp exposes genre tags); OCR/vision on flyers and album art.
4. **Classification.** One structured pass → `{p_ska_or_adjacent, genre, register ∈ {fan-hype, band-promo, record-share, review, off-topic}, language}`. Hosts the real conditional logic Graze lacked. Embedding alternative: nearest-*centroid* vs many real ska posts + negative centroids (Swedish-verb, crypto, place names), not cosine to one seed.
5. **Scoring/ranking.** Weighted combine (author_scene, classifier_p, media/link, engagement); rank by relevance × freshness. Precision/recall becomes a continuous dial.
6. **Feedback loop.** Log in-feed engagement → retrain classifier + re-weight author scores. False positives become labeled hard negatives.
7. **Dedup/diversity/freshness.** Collapse reposts/near-dupes, cap consecutive posts per author, decay by age.

### 4.5 Scene-graph identification (research methodology)

ATProto follow/interaction graphs are public and crawlable via the API (`getFollows` / `getFollowers` / `getProfile`).

- **Seeds (curated).** 20–50 unambiguous anchors: known bands, labels (Trojan, Jump Up, Bad Time, Hellcat, Asian Man, Moon Ska), scene podcasts/zines/DJs. Pick for **purity, not fame**. **Seed across geographies/sub-scenes** (UK 2-tone, US third-wave, Jamaican/rocksteady, Mexican, Japanese, Swedish) or the cluster becomes a monoculture and re-opens the foreign-language gap.
- **MVP expansion (no algorithm).** Pull each anchor's follows/followers; score candidates by anchor-connection count weighted by anchor purity; eyeball top ~200. Usable immediately as a high-confidence bypass list.
- **Workhorse: personalized PageRank.** Seed PPR on anchors over their 2-hop neighborhood (a few thousand nodes; fits in memory, e.g. NetworkX). One continuous proximity score per account; threshold = the precision/recall dial; scores degrade gracefully across boundaries (punk/reggae-adjacent land mid-band = the "dip into adjacent genres" lever). Leiden is the clustering alternative.
- **Content validation.** Run the classifier over each candidate's recent posts; high-confidence only when graph + content agree. Mixed-interest accounts = mild prior, not bypass.
- **Maintenance.** Re-run periodically; demote dormant; promote newcomers followed by existing members (hook to the feedback loop).
- **Pitfalls.** Down-weight high-degree hub accounts (false bridges). The cluster is a **prior, not a gate** — new users with few follows still enter via the text path.

### 4.6 Firehose: move to Jetstream

Currently on `wss://bsky.network` (full relay; CBOR/CAR decoded by `FirehoseSubscriptionBase`). **Switch to Jetstream**: JSON not CBOR (delete the decode layer), server-side filtering via `wantedCollections=app.bsky.feed.post`, and ~99% less bandwidth (~850 MB/day to tail everything — matters on metered hosts). Endpoint form: `wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post`. It's an **ingestion-layer-only swap**: `handleEvent` / `isSkaRelated` stay; replace the subscribe-and-decode plumbing and switch the cursor to Jetstream's `time_us`. Not urgent — do it when touching ingestion, or sooner for the bandwidth win. (Note: Jetstream is a convenience layer operated as a public good, not core infra; fine for this scale, but a dependency to be aware of.)

**Language detection upgrade (do alongside the classifier).** Replace the hand-rolled Swedish pronoun+verb heuristic with a real language-ID library — `lingua`, fastText `lid.176`, or CLD3 — and apply the §2.3 English floor in-process. More robust than per-language hand rules.

---

## 5. Architecture and components

| Component | Responsibility | Runtime shape |
|---|---|---|
| Firehose consumer | Jetstream WS subscribe, lexical prefilter, write candidates | Always-on; persistent WS |
| Indexer / store | Persist posts, likes (with subject), author scores, classifications | SQLite (Kysely) now; Postgres later if needed |
| Classifier | Structured per-post labels + language | External LLM API call (or self-hosted small model) |
| Graph job | PPR/Leiden recompute, content validation, score refresh | Scheduled (cron) |
| Feed endpoint | Serve `getFeedSkeleton` to Bluesky | HTTP (low-latency) |
| Feedback logger | Capture in-feed engagement for retraining | Part of HTTP service + store |

**Current reality:** the repo collapses consumer + HTTP server into **one process** (`FeedGenerator`) writing **one SQLite file**. That is correct and ideal for a single instance. **SQLite ⇒ single instance** (one firehose consumer is single-writer by nature). The Postgres tipping point is only when you split the consumer from the HTTP server across instances, or add a separate always-on classifier/graph worker that needs concurrent writes. Until then SQLite-on-a-volume is a feature, not debt. The graph job can run as a periodic in-process task or a separate scheduled invocation against the same DB while still single-instance.

---

## 6. Hosting

### 6.1 Requirements

A persistent WebSocket held 24/7 → **no serverless** for the consumer (Vercel/Lambda/CF Workers time out and can't hold the connection). The app is one stateful container + one SQLite file → wants a host with an always-on process + a persistent volume + automatic TLS.

### 6.2 Recommendation — Fly.io (Railway equally fine)

Fly fits this shape best: one stateful machine, a **Fly Volume mounted at `/data`** for `blueska.db`, automatic TLS, native long-lived WebSocket support. **Drop the Caddy service** — the PaaS terminates TLS, so the compose's reverse proxy is dead weight; deployment collapses to the `blueska` container + volume. Railway is an equally good second choice (usage-based, slightly simpler DX, supports volumes).

**Critical Fly gotcha — disable scale-to-zero.** Fly will idle-stop machines by default, which would kill the firehose consumer (same trap as a spin-down free tier). Set `auto_stop_machines = false` and `min_machines_running = 1`.

Minimal `fly.toml`:

```toml
app = "blueska"
primary_region = "iad"            # near a us-east Jetstream endpoint

[build]
  dockerfile = "Dockerfile"

[env]
  FEEDGEN_LISTENHOST = "0.0.0.0"
  FEEDGEN_PORT = "3000"
  FEEDGEN_SQLITE_LOCATION = "/data/blueska.db"
  FEEDGEN_HOSTNAME = "blueska.fly.dev"   # or a custom domain
  FEEDGEN_SUBSCRIPTION_ENDPOINT = "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false        # CRITICAL: keep always-on for the firehose
  auto_start_machines = true
  min_machines_running = 1

[mounts]
  source = "blueska_data"
  destination = "/data"
```

Set secrets out of band: `fly secrets set FEEDGEN_PUBLISHER_DID=did:plc:...`.

**did:web note.** `FEEDGEN_HOSTNAME` must match where `/.well-known/did.json` is served. `blueska.fly.dev` works out of the box; a custom domain needs DNS + a Fly cert. Set the hostname *before* running `yarn publishFeed`, since the published record points at the service DID.

### 6.3 Alternatives

- **Single small VPS (Hetzner/DO, ≈$5–6/mo).** Cheapest; run the existing `docker-compose` (with Caddy) as-is. You own patching/backups/uptime.
- **Render (≈$21/mo).** Good architectural fit but pricier and no free tier for always-on parts; free Postgres is hard-deleted after 30 days. Not chosen.
- **Query-time feed generator (CF Workers, ≈$0–5).** Skips the consumer by querying Bluesky search at request time — but abandons firehose indexing, the scene-graph prior, and custom scoring (most of the value). Not recommended.

### 6.4 Cost summary (small scale, monthly)

| Option | Compute + storage | Notes |
|---|---|---|
| Fly.io | ≈$5–15 | + LLM API; best shape fit; drop Caddy; disable scale-to-zero |
| Railway | ≈$5–15 | + LLM API; usage-based; volumes supported |
| VPS (Hetzner/DO) | ≈$5–6 | + LLM API; cheapest; run compose as-is incl. Caddy |
| Render | ≈$21 | + LLM API; fine but pricier; avoid free tier/DB |

LLM classification scales with volume, but the lexical prefilter cuts the firehose sharply before any model call — modest with a small model.

---

## 7. Branch sequence (rollout)

Branch off the current Blueska repo and layer additively.

1. **Eject first, features later.** Deploy current repo to Fly: add `fly.toml` (§6.2), drop Caddy, mount the volume, disable scale-to-zero, set `did:web` hostname, `yarn publishFeed`. Get the existing feed live on owned infra to de-risk hosting independently of feature work.
2. **Fix the like-decrement gap** (§4.3) — small; protects the engagement signal.
3. **Add the scene-graph prior** (§4.5) — hand-seed ~30 anchors; standalone crawler scores authors via the public graph API into a new table; `blueska.ts` boosts/bypasses in-scene authors. Highest leverage.
4. **Swap ingestion to Jetstream** (§4.6) — ingestion-layer-only; delete CBOR decode; `time_us` cursor; bandwidth win.
5. **Real language-ID + register classifier** (§4.6, §4.4) — replace the hand-rolled Swedish heuristic with a library + English floor; add the structured classifier (LLM call or centroid embeddings).
6. **Scoring refactor** — from fresh/popular interleave to a weighted relevance score (author + engagement + recency + register).

Later: multimodal/link signals, the feedback loop, per-author diversity caps.

---

## 8. Open questions and risks

- **Classifier cost at firehose scale** — depends on how hard the lexical prefilter cuts volume; measure before committing to a per-post LLM call.
- **Scene-graph cold start & drift** — seed quality sets the cluster's flavor; needs periodic refresh and hub down-weighting.
- **Adjacent-genre boundary** — how far to let dub/reggae/punk bleed in; tunable via PPR threshold, but a product decision.
- **SQLite → Postgres tipping point** — forced only by horizontal scaling or splitting consumer/server/worker across instances; defer until then.
- **Jetstream as a non-core dependency** — convenient and sufficient now; if it ever degrades, falling back to the full relay (`wss://bsky.network`) means restoring the CBOR/CAR decode path.

---

*Resolved since v1:* Graze Language Analysis is per-language select + percent (the English-floor is implementable there) — but moot given the decision to run Blueska, where language detection moves in-process.