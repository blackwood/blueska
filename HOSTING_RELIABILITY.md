# Blueska — Hosting & Reliability Runbook

A focused operations guide for running the Blueska feed generator on Fly.io: diagnosing the current incident, the gotchas that cause "feed not available" / slow loads, and a reusable reliability audit.

---

## 0. Your current incident — diagnosis

You're seeing three symptoms that are very likely **one root cause with a cascade**:

```
SqliteError: database or disk is full  (SQLITE_FULL)
could not resolve identity: did:web:blueska.fly.dev
slow / "takes a while to load"
```

**The most likely causal chain:**

1. The disk (or the SQLite DB's filesystem) **filled up** → every firehose insert now throws `SQLITE_FULL`.
2. The firehose subscription and the HTTP server run in **one process** (`FeedGenerator`), and the Kysely SQLite dialect uses a **synchronous** driver (better-sqlite3) — every query blocks Node's single event loop. Under firehose volume, a storm of *failing* synchronous writes (each one attempting, blocking, then throwing `SQLITE_FULL`) **starves the event loop**, so the HTTP server can no longer answer requests even though the process is technically alive.
3. With HTTP starved, `/.well-known/did.json` stops responding. Bluesky's AppView resolves `did:web:blueska.fly.dev` by fetching that exact URL — so it times out with **"could not resolve identity"**, surfaced to users as "feed not available."
4. Slow loads ride on top: missing DB indexes on a large table, plus the event-loop contention above.

**What the Fly machine output confirms.** The machine shows **`Started`** (so this is *not* scale-to-zero — rule out the cold-start-from-stopped theory for the *current* incident), but the health check `servicecheck-00-http-3000` is **`critical: context deadline exceeded ... while awaiting headers`**. A *timeout awaiting headers* (rather than connection-refused) is the signature of a **running-but-unresponsive process** — exactly the event-loop-starvation picture above, not a clean crash. On a small `shared-cpu-1x@1024MB` instance this happens faster and harder.

So: fix storage first (it's starving HTTP and thus identity), then fix query performance. Scale-to-zero hardening still matters for data-gap reasons (§3) but is not today's trigger.

**Immediate triage, in order:**

```bash
# 0. FIRST, the cheap check that changes everything — where does SQLite live?
fly ssh console
echo "$FEEDGEN_SQLITE_LOCATION"
```

**Branch on the answer — this is the most important fork:**

- **If it's empty or `:memory:`** (the *documented default* — easy to miss setting on Fly): your DB is **in RAM**, not on disk. On a 1024 MB box the firehose fills memory until SQLite throws `SQLITE_FULL` (an in-memory DB reports a "disk full" when it hits its page/allocation limit), while RAM pressure makes the process unresponsive — which matches the healthcheck timeout perfectly. **Extending the volume does nothing here.** The fix is to point it at the mounted volume: set `FEEDGEN_SQLITE_LOCATION=/data/blueska.db` and redeploy. (Bonus symptom that fits: a restart "fixes" it briefly because the in-memory DB starts empty, then it refills.)

- **If it's already `/data/blueska.db`**: it's a genuine full *volume* — continue below.

```bash
# 1. Confirm the volume and its usage
df -h                      # is /data its own mount? is it ~100%?
ls -la /data               # blueska.db size? check the -wal file too
du -sh /data/*

# 2. Sanity: is anything OOM-killing or restart-looping the process?
fly logs                   # SQLITE_FULL storm? "Out of memory"? repeated boots?
```

If it's a full **volume**, **extend it before anything else** (you can't `VACUUM` or even delete cleanly with zero free space — deletes into a WAL still need scratch space):

```bash
fly volumes list
fly volumes extend <volume-id> -s 5     # grow to 5 GB (adjust)
```

Then prune + reclaim (see §2.3), then confirm did:web resolves again (§1.2).

---

## 1. did:web resolution ("could not resolve identity")

### 1.1 How it works
A feed published under service DID `did:web:blueska.fly.dev` is resolved by the AppView fetching:

```
https://blueska.fly.dev/.well-known/did.json
```

That document must be reachable, valid, and **served by your running server** every time resolution is needed. Resolution therefore couples your *identity* to your *server uptime, hostname, and TLS*. Anything that takes the server down also breaks identity.

### 1.2 Verify it
From your laptop (not inside the container):

```bash
curl -sS https://blueska.fly.dev/.well-known/did.json | jq
```

You want to see, exactly:

- `"id": "did:web:blueska.fly.dev"` — must match the hostname character-for-character.
- A service entry with `"type": "BskyFeedGenerator"` and `"serviceEndpoint": "https://blueska.fly.dev"`.
- HTTP 200, `content-type: application/json`, a valid TLS cert, no auth wall, no redirect.

If `curl` hangs or fails, the server is down/asleep/unreachable — that *is* the resolution failure.

### 1.3 Common breakers
- **Server down** (disk-full crash, or scaled to zero) → did.json unreachable. This is your current case.
- **`FEEDGEN_LISTENHOST=localhost`** → the server binds loopback only, so Fly can't route external traffic to it and did.json is unreachable from outside. Must be `0.0.0.0` in a container.
- **Hostname mismatch** — `FEEDGEN_HOSTNAME` not equal to `blueska.fly.dev`, so the `id` in the doc doesn't match the DID being resolved.
- **Published with the wrong DID/hostname** — if you ran `yarn publishFeed` before the hostname was correct, the feed record points at the wrong service DID. Re-publish after fixing config.

### 1.4 Resilience recommendation: move to did:plc
`did:web` is the fragile choice precisely because resolution depends on your host being up and your hostname being stable. A **`did:plc`** service identity resolves via the PLC directory, independent of your server's uptime, and survives hostname changes (e.g. moving to a custom domain later). The feed-generator starter supports overriding identity via `FEEDGEN_SERVICE_DID`. Switching means your identity stops going dark every time the machine hiccups. Strongly worth doing before you grow the audience.

---

## 2. Storage and the `SQLITE_FULL` error

### 2.1 Gotcha #1 — is SQLite even on the volume?
The single most common Fly storage bug: the DB path doesn't point at the mounted volume, so writes go to the small ephemeral root filesystem (a few GB shared with the OS) and fill almost immediately. Confirm:

- `fly.toml` has `[mounts] source="blueska_data" destination="/data"`.
- Env has `FEEDGEN_SQLITE_LOCATION=/data/blueska.db`.
- Inside the machine, `df -h` shows `/data` as its own mount with your expected size, and `ls -la /data` shows `blueska.db` living there.

### 2.2 Gotcha #2 — unbounded growth (the real root cause)
The starter indexes matching posts **forever** with no retention. Even on a correctly-mounted volume, the firehose will fill any disk eventually. But your feed only needs recent data: the algorithm serves **fresh = last 48h** plus **popular = liked posts**. Everything older than your popular-window is dead weight.

### 2.3 Add a retention policy
Periodically delete old, unloved posts and reclaim space. Run this on an interval (in-process timer or a scheduled task):

```sql
-- Keep last 14 days, plus anything that has likes (popular bucket)
DELETE FROM post
WHERE indexedAt < datetime('now', '-14 days')
  AND likeCount = 0;
```

Then reclaim — order matters when space is tight:

```sql
PRAGMA wal_checkpoint(TRUNCATE);   -- shrink the -wal file after big deletes
PRAGMA incremental_vacuum;         -- if auto_vacuum=INCREMENTAL; else VACUUM when you have free space
```

Note: a full `VACUUM` needs free scratch space roughly equal to the DB size, so on an already-full disk you must extend the volume first, then prune, then vacuum.

### 2.4 Gotcha #3 — WAL files
In WAL mode the `-wal` sidecar grows between checkpoints and can itself fill the disk. Ensure checkpoints happen (the `wal_checkpoint(TRUNCATE)` above on your retention interval is enough for this workload). Watch `blueska.db-wal` size in `ls -la /data`.

### 2.5 Gotcha #4 — crash on write failure
A `SQLITE_FULL` (or any insert error) in the firehose handler should **degrade gracefully**, not take down the HTTP server. Wrap the insert path so a write failure logs and drops the event but keeps the process — and thus did.json — alive. The feed staying *resolvable* during a storage problem is what prevents a disk issue from becoming a total outage.

### 2.6 Sizing
Filtered ska posts are low-volume, so a few GB plus the 14-day retention above is generous. Set the volume with headroom (e.g. 5–10 GB) and alert at ~75% (§6).

---

## 3. Always-on and cold starts (the slow loads)

### 3.1 Scale-to-zero is incompatible with this app
*(Note: your machine currently shows `Started`, so scale-to-zero is **not** the active trigger for this incident — but the config below still matters, because any future idle-stop silently breaks the firehose and creates data gaps.)*

A feed generator with a firehose consumer must run **24/7**. If the machine stops when idle:
- the firehose connection dies → a **gap in indexed data** every idle period;
- the next request must **cold-start** the machine (tens of seconds) → your "takes a while to load," and often a transient did:web resolution failure while the box wakes.

Verify it's pinned on:

```toml
[http_service]
  auto_stop_machines = false
  min_machines_running = 1
```

```bash
fly status
fly machine list      # confirm the machine is "started", not "stopped"
```

### 3.2 Healthcheck, carefully
Add an HTTP healthcheck so Fly restarts a genuinely wedged machine:

```toml
[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  method = "GET"
  path = "/.well-known/did.json"
```

Caveat: don't let restart-on-failure *mask* the disk problem — a machine that restart-loops on a full disk looks "up" intermittently, which is exactly the flapping availability you've seen. Fix storage so the healthcheck reflects real health. Also point the check at a **cheap, DB-free** path; if the check itself touched the database it would fail for the same reason the real traffic does, and a longer timeout wouldn't help — the "awaiting headers" timeout means the server isn't answering *at all*, so only relieving the event loop (storage fix) clears it.

### 3.3 Why a storage problem became a *total* outage (structural)
The reason a disk/RAM issue took down identity resolution — instead of just degrading writes — is the combination of **one process** (consumer + HTTP server) and a **synchronous SQLite driver**. Failing writes block the single event loop, so serving dies with ingestion. Two levels of fix:

- **Cheap (do now):** make the firehose write path resilient — catch write errors, and back off / drop events instead of hammering a failing DB in a tight loop. A storage problem should slow ingestion, never stop the server from answering did.json and `getFeedSkeleton`.
- **Structural (when you scale):** split the firehose consumer and the HTTP server into **separate processes/machines** so serving stays responsive regardless of ingestion health. This is exactly the **SQLite → Postgres tipping point** flagged in the main spec: two processes can't share one SQLite file safely, so the split implies moving to Postgres. Until then, the resilient-write-path mitigation plus retention keeps the single process healthy.

---

## 4. Feed performance (slow `getFeedSkeleton`)

### 4.1 Add indexes (likely a big win)
The algorithm filters/sorts on `indexedAt` and `likeCount`. Without indexes, every feed request is a full table scan that gets slower as the table grows. Add migrations:

```sql
CREATE INDEX IF NOT EXISTS post_indexedAt_idx ON post (indexedAt DESC);
CREATE INDEX IF NOT EXISTS post_like_idx      ON post (likeCount DESC, indexedAt DESC);
```

### 4.2 Smaller table = faster queries
The §2.3 retention policy isn't just about disk — a 14-day table is dramatically faster to scan/sort than an unbounded one.

### 4.3 Identity resolution latency
Each cold resolution of `did:web` is a network round-trip from the AppView to your host; if your host is slow or waking, that's added latency on top of the query. `did:plc` (§1.4) removes that host-dependent hop.

### 4.4 Query hygiene
Confirm `getFeedSkeleton` returns a bounded page (respects `limit`) and that the `freshOffset:popularOffset` cursor doesn't degrade into large offset scans on deep pagination.

---

## 5. Reliability audit checklist

Run top-to-bottom; each line is independently verifiable.

**Identity**
- [ ] `curl https://<host>/.well-known/did.json` returns 200 JSON with matching `id` and `BskyFeedGenerator` service endpoint.
- [ ] `FEEDGEN_HOSTNAME` exactly equals the public hostname.
- [ ] Feed was published *after* the hostname/DID were final (`yarn publishFeed`).
- [ ] (Recommended) Service identity is `did:plc`, not `did:web`.

**Storage**
- [ ] `df -h` shows `/data` as its own mount with expected size and <75% used.
- [ ] `FEEDGEN_SQLITE_LOCATION` points at `/data/...` (the volume), not the root FS or `:memory:`.
- [ ] A retention/prune job runs on a schedule and a `wal_checkpoint(TRUNCATE)` follows it.
- [ ] Firehose insert errors are caught and don't crash the process.

**Availability**
- [ ] `auto_stop_machines = false`, `min_machines_running = 1`.
- [ ] `fly machine list` shows the machine continuously "started."
- [ ] `FEEDGEN_LISTENHOST = 0.0.0.0`.
- [ ] Healthcheck configured against a cheap, DB-free endpoint.

**Performance**
- [ ] Indexes exist on `post(indexedAt)` and `post(likeCount, indexedAt)`.
- [ ] `getFeedSkeleton` respects `limit` and returns within ~1s on a warm machine.

**Liveness of the data**
- [ ] The firehose cursor is advancing (the feed has posts from the last few minutes), proving the consumer is actually connected — not just that the HTTP server is up.

---

## 6. Monitoring and alerting

- **Logs:** `fly logs` — watch for `SQLITE_FULL`, reconnect storms, unhandled rejections.
- **Disk:** alert at ~75% volume usage (a full disk is the failure mode that cascades into an identity outage).
- **Firehose liveness:** the subtle one — the HTTP server can be perfectly healthy while the firehose has silently disconnected, so the feed slowly goes stale. Track "newest `indexedAt` in the DB" and alert if it's older than a few minutes. This catches the failure your uptime check won't.
- **Synthetic check:** periodically `curl` did.json *and* hit `getFeedSkeleton` for your feed, asserting both a 200 and non-empty results.

---

## 7. Hardening, in priority order

1. **Find out where SQLite lives** (`echo $FEEDGEN_SQLITE_LOCATION`). If `:memory:`/unset → set it to `/data/blueska.db` and redeploy (this alone likely ends the incident). If already on the volume → **extend the volume** to clear `SQLITE_FULL` now.
2. **Add a retention job + WAL checkpointing** so it doesn't refill (the actual fix).
3. **Make the firehose write path resilient** (catch/back-off on errors) so storage trouble slows ingestion instead of starving HTTP and taking down identity.
4. **Confirm always-on** (`auto_stop_machines=false`, machine started, `0.0.0.0`).
5. **Add the two indexes** to fix slow loads.
6. **Migrate `did:web` → `did:plc`** so identity stops depending on server uptime/hostname.
7. **Add firehose-liveness + disk/RAM monitoring** so the next incident pages you before users see it.
8. **(At scale) split consumer from server → Postgres** so serving never dies with ingestion.

Items 1–3 resolve the current outage; 4–5 fix the slowness; 6–8 prevent recurrence.