// Usage: yarn checkHealth [--local]
//
// Runs HTTP smoke tests against the feed generator, plus DB checks.
//
//   --local   Target http://localhost:FEEDGEN_PORT instead of prod hostname
//
// DB resolution order:
//   1. FEEDGEN_SQLITE_LOCATION env var (if set to an existing file)
//   2. Auto-pull from prod via `fly sftp get` (default, prod mode only)
//   3. Skip DB checks (--local with no file, or fly unavailable)

import dotenv from 'dotenv'
import fs from 'fs'
import { spawnSync } from 'child_process'
import { sql } from 'kysely'
import { createDb } from '../src/db'

dotenv.config()

const LOCAL = process.argv.includes('--local')
const port = process.env.FEEDGEN_PORT ?? '3000'
const hostname = process.env.FEEDGEN_HOSTNAME ?? 'blueska.fly.dev'
const baseUrl = LOCAL ? `http://localhost:${port}` : `https://${hostname}`
const publisherDid = process.env.FEEDGEN_PUBLISHER_DID ?? ''
const sqliteLocation = process.env.FEEDGEN_SQLITE_LOCATION ?? ''

const FEED_URI = publisherDid
  ? `at://${publisherDid}/app.bsky.feed.generator/blueska`
  : ''

const AT_URI_RE =
  /^at:\/\/did:[a-z]+:[a-zA-Z0-9._:%-]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9]+$/

// ── result tracking ──────────────────────────────────────────────────────────

let passed = 0
let failed = 0
let skipped = 0

function ok(label: string, detail?: string) {
  passed++
  const d = detail ? `  (${detail})` : ''
  console.log(`  \x1b[32m✓\x1b[0m  ${label}${d}`)
}

function fail(label: string, detail?: string) {
  failed++
  const d = detail ? `  — ${detail}` : ''
  console.log(`  \x1b[31m✗\x1b[0m  ${label}${d}`)
}

function warn(label: string, detail?: string) {
  const d = detail ? `  — ${detail}` : ''
  console.log(`  \x1b[33m!\x1b[0m  ${label}${d}`)
}

function info(label: string, detail?: string) {
  const d = detail ? `  — ${detail}` : ''
  console.log(`  \x1b[2m·\x1b[0m  ${label}${d}`)
}

function skip(label: string, reason: string) {
  skipped++
  console.log(`  \x1b[2m–\x1b[0m  ${label}  (skipped: ${reason})`)
}

function section(name: string) {
  console.log(`\n${name}`)
  console.log('─'.repeat(name.length))
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function getJson(
  url: string,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  try {
    const res = await fetch(url)
    let body: Record<string, unknown> = {}
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      // non-JSON response
    }
    return { ok: res.ok, status: res.status, body }
  } catch {
    return { ok: false, status: 0, body: {} }
  }
}

// ── HTTP checks ──────────────────────────────────────────────────────────────

async function checkHealth() {
  section('HTTP: /health')
  const { ok: httpOk, status, body } = await getJson(`${baseUrl}/health`)
  if (!httpOk) {
    fail('/health reachable', status === 0 ? 'connection refused' : `HTTP ${status}`)
    return
  }
  ok('/health reachable', `HTTP ${status}`)

  if (body.status === 'ok') {
    ok('status', 'ok')
  } else {
    fail('status', String(body.status ?? 'unknown'))
  }

  const lag = body.firehoseLagSeconds
  if (lag === null || lag === undefined) {
    fail('firehose lag', 'null — subscription not yet connected')
  } else if (typeof lag === 'number' && lag < 60) {
    ok('firehose lag', `${lag}s`)
  } else if (typeof lag === 'number' && lag < 300) {
    warn('firehose lag', `${lag}s — elevated but below degraded threshold (300s)`)
  } else {
    fail('firehose lag', `${lag}s — above 300s degraded threshold`)
  }

  const dbBytes = body.dbSizeBytes
  if (dbBytes === null || dbBytes === undefined) {
    skip('db size', 'in-memory or stat failed')
  } else {
    const mb = Math.round((dbBytes as number) / 1024 / 1024)
    if (mb < 2000) {
      ok('db size', `${mb} MB`)
    } else {
      warn('db size', `${mb} MB — approaching 3 GB warning threshold`)
    }
  }
}

async function checkWellKnown() {
  section('HTTP: /.well-known/did.json')
  const { ok: httpOk, status, body } = await getJson(
    `${baseUrl}/.well-known/did.json`,
  )
  if (!httpOk) {
    fail('did.json reachable', `HTTP ${status}`)
    return
  }
  ok('did.json reachable', `HTTP ${status}`)

  if (typeof body.id === 'string' && body.id.startsWith('did:')) {
    ok('id field valid', body.id)
  } else {
    fail('id field valid', 'missing or not a DID')
  }

  const services = body.service
  if (Array.isArray(services) && services.length > 0) {
    ok('service endpoints present', `${services.length} entry`)
  } else {
    fail('service endpoints present', 'empty or missing service array')
  }
}

async function checkFeedSkeleton() {
  section('HTTP: getFeedSkeleton')
  if (!FEED_URI) {
    skip('feed skeleton', 'FEEDGEN_PUBLISHER_DID not set in .env')
    return
  }

  const url = `${baseUrl}/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(FEED_URI)}&limit=5`
  const { ok: httpOk, status, body } = await getJson(url)

  if (!httpOk) {
    if (body.error) {
      fail('getFeedSkeleton', `${body.error}: ${body.message ?? ''}`)
    } else {
      fail('getFeedSkeleton reachable', `HTTP ${status}`)
    }
    return
  }
  ok('getFeedSkeleton responds', `HTTP ${status}`)

  if (!Array.isArray(body.feed)) {
    fail('feed array present', `got ${typeof body.feed}`)
    return
  }

  if (body.feed.length === 0) {
    warn('feed non-empty', 'empty — DB cold, firehose stalled, or no posts indexed yet')
  } else {
    ok('feed non-empty', `${body.feed.length} posts returned`)
    const items = body.feed as Array<{ post: string }>
    const bad = items.filter((item) => !AT_URI_RE.test(item.post ?? ''))
    if (bad.length > 0) {
      fail('AT-URI format', `malformed: ${bad[0].post}`)
    } else {
      ok('AT-URI format', 'all valid')
    }
  }

  if (body.cursor !== undefined) {
    ok('cursor present', String(body.cursor))
  } else {
    fail('cursor present', 'missing — pagination broken when feed reaches limit')
  }
}

// ── DB checks ────────────────────────────────────────────────────────────────

type DB = ReturnType<typeof createDb>

async function checkPosts(db: DB) {
  section('DB: post table')

  const now = new Date()
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  const totals = await db
    .selectFrom('post')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const count = Number(totals?.n ?? 0)

  if (count === 0) {
    fail('post count', '0 — firehose may not be indexing')
    return
  }
  ok('post count', `${count.toLocaleString()} rows`)

  const recentRow = await db
    .selectFrom('post')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('indexedAt', '>', cutoff24h)
    .executeTakeFirst()
  const recentCount = Number(recentRow?.n ?? 0)
  if (recentCount > 0) {
    ok('posts in last 24h', recentCount.toLocaleString())
  } else {
    fail('posts in last 24h', '0 — firehose may have stalled')
  }

  const newest = await db
    .selectFrom('post')
    .select('indexedAt')
    .orderBy('indexedAt', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (newest) {
    const ageMin = Math.round(
      (now.getTime() - new Date(newest.indexedAt).getTime()) / 60_000,
    )
    info('newest post age', `${ageMin} min ago${ageMin > 60 ? ' (note: pulled DB will always be stale)' : ''}`)
  }
}

async function checkLikes(db: DB) {
  section('DB: like tracking')

  const likeRow = await db
    .selectFrom('like')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const n = Number(likeRow?.n ?? 0)
  if (n > 0) {
    ok('like table populated', `${n.toLocaleString()} rows`)
  } else {
    fail('like table populated', '0 — like tracking may be broken')
  }

  const withLikesRow = await db
    .selectFrom('post')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('likeCount', '>', 0)
    .executeTakeFirst()
  const withLikes = Number(withLikesRow?.n ?? 0)
  if (withLikes > 0) {
    ok('posts with likes', withLikes.toLocaleString())
  } else {
    fail('posts with likes', '0 — likeCount not being incremented')
  }
}

async function checkTierDistribution(db: DB) {
  section('DB: inclusion / tier distribution')

  const result = await sql<{ inclusionReason: string; n: number }>`
    SELECT inclusionReason, COUNT(*) as n
    FROM post
    GROUP BY inclusionReason
    ORDER BY n DESC
  `.execute(db)

  const rows = result.rows
  if (rows.length === 0) {
    fail('distribution', 'no posts')
    return
  }

  const total = rows.reduce((s, r) => s + Number(r.n), 0)
  const dist = rows
    .map((r) => `${r.inclusionReason}: ${Number(r.n).toLocaleString()}`)
    .join('  |  ')
  ok('breakdown', dist)

  const keywordRow = rows.find((r) => r.inclusionReason === 'keyword')
  const keywordPct = keywordRow ? (Number(keywordRow.n) / total) * 100 : 0
  if (keywordPct === 100) {
    warn('affinity posts', '0% — only keyword posts; run yarn syncSceneGraph?')
  } else {
    const affinityPct = Math.round(100 - keywordPct)
    ok('affinity posts', `${affinityPct}% from scene graph`)
  }

  const meteredRow = rows.find((r) => r.inclusionReason === 'metered')
  if (meteredRow) {
    info('metered posts', Number(meteredRow.n).toLocaleString())
  }
}

async function checkAuthorScores(db: DB) {
  section('DB: author scores')

  const countRow = await db
    .selectFrom('author_score')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const count = Number(countRow?.n ?? 0)

  if (count === 0) {
    fail('author_score populated', '0 rows — run yarn syncSceneGraph')
    return
  }
  ok('author_score count', `${count.toLocaleString()} accounts`)

  const tiers = await sql<{ tier: string; n: number }>`
    SELECT tier, COUNT(*) as n
    FROM author_score
    GROUP BY tier
    ORDER BY n DESC
  `.execute(db)

  if (tiers.rows.length > 0) {
    const tierStr = tiers.rows
      .map((t) => `${t.tier}: ${Number(t.n).toLocaleString()}`)
      .join('  |  ')
    ok('tier breakdown', tierStr)

    const blocked = tiers.rows.find((t) => t.tier === 'blocked')
    if (blocked) {
      info('blocked accounts', Number(blocked.n).toLocaleString())
    }
  }

  const staleRow = await db
    .selectFrom('author_score')
    .select('updatedAt')
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (staleRow) {
    const ageD = Math.round(
      (Date.now() - new Date(staleRow.updatedAt).getTime()) / (24 * 60 * 60 * 1000),
    )
    if (ageD <= 35) {
      ok('scene graph freshness', `last crawled ${ageD}d ago`)
    } else {
      warn('scene graph freshness', `last crawled ${ageD}d ago — consider running yarn syncSceneGraph`)
    }
  }
}

async function checkFeedStats(db: DB) {
  section('DB: feed component stats')

  const stats = await db
    .selectFrom('post')
    .select((eb) => [
      eb.fn.avg<number>('likeCount').as('avgLikes'),
      eb.fn.max<number>('likeCount').as('maxLikes'),
      eb.fn.avg<number>('lexiconScore').as('avgLexicon'),
      eb.fn.max<number>('lexiconScore').as('maxLexicon'),
    ])
    .executeTakeFirst()

  if (!stats) {
    skip('feed stats', 'no rows')
    return
  }

  info(
    'like distribution',
    `avg ${Number(stats.avgLikes ?? 0).toFixed(2)}  max ${Number(stats.maxLikes ?? 0)}`,
  )
  info(
    'lexicon distribution',
    `avg ${Number(stats.avgLexicon ?? 0).toFixed(3)}  max ${Number(stats.maxLexicon ?? 0).toFixed(3)}`,
  )
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const target = LOCAL ? `localhost:${port}` : hostname
  console.log(`\nBlueska health check — ${target}`)

  await checkHealth()
  await checkWellKnown()
  await checkFeedSkeleton()

  // Resolve DB path: explicit env var first, then auto-pull from prod.
  let dbPath: string | null = null
  if (sqliteLocation && sqliteLocation !== ':memory:' && fs.existsSync(sqliteLocation)) {
    dbPath = sqliteLocation
  } else if (!LOCAL) {
    const tmpPath = '/tmp/blueska-healthcheck.db'
    process.stdout.write('\nPulling DB from prod...')
    const result = spawnSync('fly', ['sftp', 'get', '/data/blueska.db', tmpPath], {
      stdio: 'pipe',
    })
    if (result.status === 0 && fs.existsSync(tmpPath)) {
      console.log(' done')
      dbPath = tmpPath
    } else {
      const stderr = result.stderr?.toString().trim()
      console.log(` failed${stderr ? ` (${stderr.split('\n')[0]})` : ''}`)
      console.log('  (DB checks skipped — fly not available or not authenticated)')
    }
  }

  if (dbPath) {
    const sizeMB = Math.round(fs.statSync(dbPath).size / 1024 / 1024)
    console.log(`\nDB: ${dbPath}  (${sizeMB} MB)`)
    const db = createDb(dbPath)
    const dbChecks: [string, (db: DB) => Promise<void>][] = [
      ['posts', checkPosts],
      ['likes', checkLikes],
      ['tier distribution', checkTierDistribution],
      ['author scores', checkAuthorScores],
      ['feed stats', checkFeedStats],
    ]
    for (const [name, fn] of dbChecks) {
      try {
        await fn(db)
      } catch (err) {
        failed++
        const msg = (err as Error).message ?? String(err)
        console.log(`  \x1b[31m✗\x1b[0m  ${name} — ${msg}`)
      }
    }
    await db.destroy()
  } else if (LOCAL) {
    console.log('\n(DB checks skipped — set FEEDGEN_SQLITE_LOCATION to a local DB file)')
  }

  // summary
  const total = passed + failed + skipped
  console.log(`\n${'─'.repeat(48)}`)
  const line =
    failed > 0
      ? `\x1b[31m${failed} failed\x1b[0m  ${passed} passed  ${skipped} skipped`
      : `\x1b[32mall ${passed} passed\x1b[0m  ${skipped} skipped`
  console.log(`${total} checks  —  ${line}`)
  console.log('')

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
