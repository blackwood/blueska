// Usage: yarn previewFeed [--limit=N] [--no-fetch]
//   --limit=N    Posts to show (default 20)
//   --no-fetch   Skip fetching post text from Bluesky API

import dotenv from 'dotenv'
import { createDb } from '../src/db'

dotenv.config()

const API = 'https://public.api.bsky.app/xrpc'
const WEIGHTS = { author: 0.4, freshness: 0.3, engagement: 0.2, lexicon: 0.1 }
const FRESH_WINDOW_MS = 48 * 60 * 60 * 1000

async function fetchTexts(uris: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < uris.length; i += 25) {
    const batch = uris.slice(i, i + 25)
    const qs = batch.map((u) => `uris=${encodeURIComponent(u)}`).join('&')
    try {
      const res = await fetch(`${API}/app.bsky.feed.getPosts?${qs}`)
      if (!res.ok) continue
      const data = (await res.json()) as {
        posts: Array<{ uri: string; record?: { text?: string } }>
      }
      for (const p of data.posts) {
        out.set(p.uri, p.record?.text ?? '')
      }
    } catch {
      // non-fatal — text just won't show
    }
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const limitArg = args.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 20
  const noFetch = args.includes('--no-fetch')

  const sqliteLocation = process.env.FEEDGEN_SQLITE_LOCATION ?? 'blueska.db'
  console.log(`DB: ${sqliteLocation}`)

  const db = createDb(sqliteLocation)
  const now = new Date()
  const freshWindow = new Date(now.getTime() - FRESH_WINDOW_MS).toISOString()

  const candidates = await db
    .selectFrom('post')
    .selectAll()
    .where((eb) =>
      eb.or([eb('indexedAt', '>', freshWindow), eb('likeCount', '>', 0)]),
    )
    .orderBy('indexedAt', 'desc')
    .limit(limit * 5)
    .execute()

  const authorDids = [
    ...new Set(candidates.map((p) => p.authorDid).filter(Boolean)),
  ]
  const authorScoreMap = new Map<string, number>()
  if (authorDids.length > 0) {
    const rows = await db
      .selectFrom('author_score')
      .select(['did', 'score'])
      .where('did', 'in', authorDids)
      .execute()
    for (const r of rows) authorScoreMap.set(r.did, r.score)
  }

  const scored = candidates.map((post) => {
    const ageMs = now.getTime() - new Date(post.indexedAt).getTime()
    const freshness = Math.exp(-ageMs / FRESH_WINDOW_MS)
    const engagement = Math.min(1, Math.log1p(post.likeCount) / Math.log(10))
    const authorScene = authorScoreMap.get(post.authorDid) ?? 0
    const lexicon = post.lexiconScore ?? 0
    const score =
      WEIGHTS.author * authorScene +
      WEIGHTS.freshness * freshness +
      WEIGHTS.engagement * engagement +
      WEIGHTS.lexicon * lexicon
    return { post, score, freshness, engagement, authorScene, lexicon }
  })

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)

  let textMap = new Map<string, string>()
  if (!noFetch) {
    process.stdout.write(`Fetching text for ${top.length} posts... `)
    textMap = await fetchTexts(top.map((t) => t.post.uri))
    console.log('done')
  }

  const affinityCount = top.filter(
    (t) => (t.post.inclusionReason ?? 'keyword') === 'affinity',
  ).length
  const knownAuthors = top.filter((t) => t.authorScene > 0).length
  console.log(
    `\nTop ${top.length} of ${candidates.length} candidates — ${affinityCount} affinity, ${top.length - affinityCount} keyword — ${knownAuthors} from known scene accounts`,
  )
  console.log(
    `Author scores: ${authorScoreMap.size} loaded (0 = run yarn crawlSceneGraph first)\n`,
  )

  for (let i = 0; i < top.length; i++) {
    const { post, score, freshness, engagement, authorScene, lexicon } = top[i]
    const reason = post.inclusionReason ?? 'keyword'
    const ageH = Math.round(
      (now.getTime() - new Date(post.indexedAt).getTime()) / 3_600_000,
    )
    const tag = reason === 'affinity' ? '[affinity]' : '[keyword]'

    console.log(
      `#${String(i + 1).padStart(2)}  ${score.toFixed(3)}  ${tag}  ${ageH}h ago  ❤ ${post.likeCount}`,
    )
    console.log(
      `      auth=${(WEIGHTS.author * authorScene).toFixed(3)}  ` +
        `fresh=${(WEIGHTS.freshness * freshness).toFixed(3)}  ` +
        `eng=${(WEIGHTS.engagement * engagement).toFixed(3)}  ` +
        `lex=${(WEIGHTS.lexicon * lexicon).toFixed(3)}`,
    )
    const text = textMap.get(post.uri)
    if (text) {
      console.log(`      "${text.slice(0, 120).replace(/\n/g, ' ')}"`)
    } else if (!noFetch) {
      console.log(`      (deleted or unavailable)`)
    }
    console.log(`      ${post.uri}`)
    console.log()
  }

  await db.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
