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

import dotenv from 'dotenv'
import { sql } from 'kysely'
import { AtpAgent } from '@atproto/api'
import { createDb, migrateToLatest } from '../src/db'

dotenv.config()

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
  do {
    try {
      const res = await agent.api.app.bsky.graph.getFollows({
        actor: did,
        limit: 100,
        cursor,
      })
      for (const f of res.data.follows) {
        dids.push(f.did)
      }
      cursor = res.data.cursor
    } catch (err) {
      console.warn(`  ! Could not fetch follows for ${did}:`, err)
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
  if (seedDids.length === 0) {
    console.error('No seed handles resolved. Check your SEED_HANDLES list.')
    process.exit(1)
  }

  // --- Step 2: Fetch follows for each seed ---
  console.log(`\nFetching follows for ${seedDids.length} seeds...`)
  const connectionCount = new Map<string, number>()
  for (let i = 0; i < seedDids.length; i++) {
    const did = seedDids[i]
    process.stdout.write(`  [${i + 1}/${seedDids.length}] ${did} ... `)
    const follows = await getFollows(agent, did)
    for (const followDid of follows) {
      connectionCount.set(followDid, (connectionCount.get(followDid) ?? 0) + 1)
    }
    console.log(`${follows.length} follows`)
    await new Promise((r) => setTimeout(r, API_DELAY_MS))
  }

  // --- Step 3: Build score list ---
  const now = new Date().toISOString()
  const upserts: { did: string; score: number; updatedAt: string }[] = []

  for (const did of seedDids) {
    upserts.push({ did, score: 1.0, updatedAt: now })
  }

  for (const [did, count] of connectionCount.entries()) {
    if (seedDids.includes(did)) continue
    const score = count / seedDids.length
    if (score >= SCORE_THRESHOLD) {
      upserts.push({ did, score, updatedAt: now })
    }
  }

  console.log(
    `\nWriting ${upserts.length} author scores (threshold ≥${SCORE_THRESHOLD})...`,
  )

  const chunkSize = 100
  for (let i = 0; i < upserts.length; i += chunkSize) {
    const chunk = upserts.slice(i, i + chunkSize)
    await db
      .insertInto('author_score')
      .values(chunk)
      .onConflict((oc) =>
        oc.doUpdateSet({
          score: sql<number>`excluded.score`,
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
