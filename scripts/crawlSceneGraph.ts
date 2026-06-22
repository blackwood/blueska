/**
 * Scene graph crawler — scores Bluesky accounts by their proximity to known ska scene seeds.
 *
 * Usage:
 *   yarn ts-node scripts/crawlSceneGraph.ts
 *
 * Set up:
 *   1. Add seed handles to SEED_HANDLES below (see §4.5 of SPEC.md for guidance).
 *   2. Run with FEEDGEN_SQLITE_LOCATION pointing at your DB.
 *   3. Re-run periodically (weekly or after events) to refresh scores.
 *
 * Scoring:
 *   - Seeds get score 1.0 (unambiguous scene members).
 *   - Candidates get score = (seeds_that_follow_them / total_seeds).
 *   - Only candidates with score ≥ 0.05 (≥5% of seeds follow them) are written.
 *   - The score is a continuous prior: 0.4× weight in the feed ranking formula.
 */

import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { sql } from 'kysely'
import { AtpAgent } from '@atproto/api'
import { createDb, migrateToLatest } from '../src/db'

dotenv.config()

// Per-account tier overrides. Accounts not listed here default to 'full'.
// Edit data/account-tiers.json and re-run yarn syncSceneGraph to apply.
//
//   full       — full affinity bypass: root posts AND replies indexed
//   posts_only — root posts only: replies still need keyword gate
//   metered    — root posts only, 1-per-page cap, like threshold in algo
//   blocked    — totally excluded: no posts indexed regardless of keywords
const TIERS_PATH = path.join(__dirname, '../data/account-tiers.json')
type TiersConfig = { tiers: { posts_only?: string[]; metered?: string[]; blocked?: string[] } }
const tiersConfig: TiersConfig = fs.existsSync(TIERS_PATH)
  ? (JSON.parse(fs.readFileSync(TIERS_PATH, 'utf8')) as TiersConfig)
  : { tiers: {} }

// ---------------------------------------------------------------------------
// Seed accounts — fill these in with real Bluesky handles.
//
// Guidance (§4.5):
//   - Favor purity over fame: labels, scene podcasts, zines, DJs before
//     mainstream crossover artists.
//   - Seed across sub-scenes/geographies so the cluster doesn't become a
//     monoculture: UK 2-tone, US third-wave, Jamaican rocksteady, MX, JP, SE.
//   - Down-weight high-follower hub accounts later if the cluster blurs.
// ---------------------------------------------------------------------------
const SEED_HANDLES: string[] = [
  // Examples — verify handles before running:
  'badtimerecords.bsky.social',
  'jumpuprecords.bsky.social',
  'asianmanrecords.bsky.social',
  'catbiteband.bsky.social',
  'skatunenetwork.bsky.social',
  'trojanrecords.bsky.social',
  'jeffrosenstock.bsky.social',
  'supernovaska.bsky.social',
  'estmusic.bsky.social',
  'badoperation.bsky.social',
  'pietasters.bsky.social',
  'theslackersband.bsky.social',
  'thenewlimits.bsky.social',
  'suburbanlegends.com',
  'wearetheunion.bsky.social',
  'omnigone.band',
  'abbeyproductions.bsky.social',
  'halfpasttwoska.bsky.social',
  'reel-big-fish.com',
  'bluebeatoftheday.bsky.social',
  'ontheupbeat.bsky.social',
  'theselecter.bsky.social',
  'voodooglowskulls.bsky.social',
  'ringdingofficial.bsky.social',
  'did:plc:dmcjvzmvujbtr4l7m7kcp3k2', // ska punk international
  'skavoovie.bsky.social',
  'indefenseofska.bsky.social',
  'thisisskaradio.bsky.social',
  'thisisskajazz.bsky.social',
  'theskamailman.bsky.social',

  // Bands
  'dancehallcrashers.bsky.social',
  'steppinrazorblades.bsky.social', // New England Ska Punk
  'pwrup.bsky.social',              // Western Mass Skacore

  // Individual artists / scene members
  'reade.bsky.social',              // Reade of We Are the Union
  '2oh3.bsky.social',              // Cody Freedom — saxophone, show promoter, 2025 ska releases playlist

  // Promoters / venues / regional scenes
  '413ska.bsky.social',            // Western Mass Ska & Punk Shows
  'staywhelmed413.bsky.social',    // Stay Whelmed Productions (Western Mass DIY booking)

  // Media / press
  'skagazine.bsky.social',         // SKAgazine — zine + podcast
  'readjunk.bsky.social',          // ReadJunk.com (profile gated — may fail to resolve)

  // Add your verified handles above this line.
]

const SCORE_THRESHOLD = 0.05
const MAX_FOLLOWS_PER_SEED = 500
const API_DELAY_MS = 250

async function resolveHandle(
  agent: AtpAgent,
  handle: string,
): Promise<string | null> {
  try {
    const res = await agent.api.app.bsky.actor.getProfile({ actor: handle })
    return res.data.did
  } catch {
    console.warn(`  ! Could not resolve handle: ${handle}`)
    return null
  }
}

async function getFollows(agent: AtpAgent, did: string): Promise<string[]> {
  const dids: string[] = []
  let cursor: string | undefined
  let page = 0
  do {
    page++
    try {
      const res = await agent.api.app.bsky.graph.getFollows({
        actor: did,
        limit: 100,
        cursor,
      })
      const batch = res.data.follows.length
      for (const f of res.data.follows) {
        dids.push(f.did)
      }
      cursor = res.data.cursor
      process.stdout.write(` p${page}(${dids.length})`)
    } catch (err) {
      console.warn(`\n  ! Could not fetch follows for ${did} (page ${page}):`, err)
      break
    }
  } while (cursor && dids.length < MAX_FOLLOWS_PER_SEED)
  return dids
}

async function main() {
  if (SEED_HANDLES.length === 0) {
    console.error(
      'No seed handles configured.\n' +
        'Edit scripts/crawlSceneGraph.ts and add handles to SEED_HANDLES.',
    )
    process.exit(1)
  }

  const sqliteLocation = process.env.FEEDGEN_SQLITE_LOCATION ?? 'blueska.db'
  console.log(`Using DB: ${sqliteLocation}`)
  const db = createDb(sqliteLocation)
  await migrateToLatest(db)

  const agent = new AtpAgent({ service: 'https://public.api.bsky.app' })

  // --- Step 1: Resolve seed handles to DIDs ---
  console.log(`\nResolving ${SEED_HANDLES.length} seed handles...`)
  const seedDids: string[] = []
  for (const handle of SEED_HANDLES) {
    const did = await resolveHandle(agent, handle)
    if (did) {
      seedDids.push(did)
      console.log(`  ✓ ${handle} → ${did}`)
    }
  }

  // Resolve tier overrides to DIDs so we can apply them when writing scores
  const postsOnlyDids = new Set<string>()
  const meteredDids = new Set<string>()
  const blockedDids = new Set<string>()
  const tierEntries: [string, string[]][] = [
    ['posts_only', tiersConfig.tiers.posts_only ?? []],
    ['metered',    tiersConfig.tiers.metered    ?? []],
    ['blocked',    tiersConfig.tiers.blocked    ?? []],
  ]
  const allTierHandles = tierEntries.flatMap(([, handles]) => handles)
  if (allTierHandles.length > 0) {
    console.log(`\nResolving ${allTierHandles.length} tier-override handle(s)...`)
    for (const [tierName, handles] of tierEntries) {
      for (const handle of handles) {
        const did = await resolveHandle(agent, handle)
        if (did) {
          if (tierName === 'blocked') blockedDids.add(did)
          else if (tierName === 'metered') meteredDids.add(did)
          else postsOnlyDids.add(did)
          console.log(`  ${tierName}: ${handle} → ${did}`)
        }
      }
    }
  }
  if (seedDids.length === 0) {
    console.error('No seed handles resolved. Check your SEED_HANDLES list.')
    process.exit(1)
  }

  // --- Step 2: Fetch follows for each seed ---
  console.log(`\nFetching follows for ${seedDids.length} seeds...`)
  const connectionCount = new Map<string, number>()
  const t0 = Date.now()
  for (let i = 0; i < seedDids.length; i++) {
    const did = seedDids[i]
    const handle = SEED_HANDLES.find((h) => !h.startsWith('did:')) ?? did
    process.stdout.write(`  [${i + 1}/${seedDids.length}] ${did}`)
    const follows = await getFollows(agent, did)
    for (const followDid of follows) {
      connectionCount.set(followDid, (connectionCount.get(followDid) ?? 0) + 1)
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(` → ${follows.length} follows  (${elapsed}s elapsed, ${connectionCount.size} unique candidates so far)`)
    await new Promise((r) => setTimeout(r, API_DELAY_MS))
  }

  // --- Step 3: Build score list ---
  const now = new Date().toISOString()
  const upserts: { did: string; score: number; tier: string; updatedAt: string }[] = []

  const tierFor = (did: string) =>
    blockedDids.has(did) ? 'blocked'
    : meteredDids.has(did) ? 'metered'
    : postsOnlyDids.has(did) ? 'posts_only'
    : 'full'

  for (const did of seedDids) {
    upserts.push({ did, score: 1.0, tier: tierFor(did), updatedAt: now })
  }

  let belowThreshold = 0
  for (const [did, count] of connectionCount.entries()) {
    if (seedDids.includes(did)) continue
    const score = count / seedDids.length
    if (score >= SCORE_THRESHOLD) {
      upserts.push({ did, score, tier: tierFor(did), updatedAt: now })
    } else {
      belowThreshold++
    }
  }

  // Blocked accounts must be in the DB even if no seeds follow them —
  // the server checks tier at event time to hard-exclude their posts.
  for (const did of blockedDids) {
    if (!upserts.some((u) => u.did === did)) {
      upserts.push({ did, score: 0, tier: 'blocked', updatedAt: now })
    }
  }

  console.log(
    `\n${connectionCount.size} unique candidates: ${upserts.length - seedDids.length} above threshold, ${belowThreshold} below (threshold ≥${SCORE_THRESHOLD})`,
  )
  console.log(`Writing ${upserts.length} author scores (${seedDids.length} seeds + ${upserts.length - seedDids.length} candidates)...`)

  const chunkSize = 100
  for (let i = 0; i < upserts.length; i += chunkSize) {
    const chunk = upserts.slice(i, i + chunkSize)
    await db
      .insertInto('author_score')
      .values(chunk)
      .onConflict((oc) =>
        oc.doUpdateSet({
          score: sql<number>`excluded.score`,
          tier: sql<string>`excluded.tier`,
          updatedAt: sql<string>`excluded.updatedAt`,
        }),
      )
      .execute()
  }

  // --- Step 4: Print top results ---
  console.log('\nTop 20 author scores:')
  const top = await db
    .selectFrom('author_score')
    .selectAll()
    .orderBy('score', 'desc')
    .limit(20)
    .execute()
  for (const row of top) {
    console.log(
      `  score=${row.score.toFixed(3)}  ${row.did}  (updated ${row.updatedAt})`,
    )
  }

  await db.destroy()
  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
