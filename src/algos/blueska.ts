import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

// max 15 chars
export const shortname = 'blueska'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const limit = params.limit ?? 50
  const now = new Date()
  const freshWindow = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()

  // Cursor is a page number (0-indexed)
  const page = params.cursor ? parseInt(params.cursor, 10) || 0 : 0

  // Fetch enough candidates to cover this page, capped to avoid huge scans
  const scanDepth = Math.min((page + 1) * limit * 5, 1000)

  const candidates = await ctx.db
    .selectFrom('post')
    .selectAll()
    .where((eb) =>
      eb.or([eb('indexedAt', '>', freshWindow), eb('likeCount', '>', 0)]),
    )
    .orderBy('indexedAt', 'desc')
    .limit(scanDepth)
    .execute()

  // Batch-fetch author scores for the candidate set
  const authorDids = [
    ...new Set(candidates.map((p) => p.authorDid).filter(Boolean)),
  ]
  const authorScoreMap = new Map<string, number>()
  if (authorDids.length > 0) {
    const scores = await ctx.db
      .selectFrom('author_score')
      .select(['did', 'score'])
      .where('did', 'in', authorDids)
      .execute()
    for (const s of scores) {
      authorScoreMap.set(s.did, s.score)
    }
  }

  // Composite relevance score.
  // Weights are provisional — run /health or check retention logs to see actual
  // component distributions before trusting these numbers. A component with low
  // variance across candidates contributes far less than its nominal weight suggests.
  //
  // authorScene: bimodal/sparse (0 if scene graph not built yet — run crawlSceneGraph)
  // freshness:   0–1 exp decay over 48h
  // engagement:  log-normalised likeCount, 0–1
  // lexiconScore: 0–1 exp curve, see src/util/lexiconScore.ts — re-ranker only
  const WEIGHTS = { author: 0.40, freshness: 0.30, engagement: 0.20, lexicon: 0.10 }

  const scored = candidates.map((post) => {
    const ageMs = now.getTime() - new Date(post.indexedAt).getTime()
    const freshness = Math.exp(-ageMs / (48 * 60 * 60 * 1000))
    const engagement = Math.min(1, Math.log1p(post.likeCount) / Math.log(10))
    const authorScene = authorScoreMap.get(post.authorDid) ?? 0
    const lexicon = post.lexiconScore ?? 0
    const score =
      WEIGHTS.author * authorScene +
      WEIGHTS.freshness * freshness +
      WEIGHTS.engagement * engagement +
      WEIGHTS.lexicon * lexicon
    return { post: post.uri, score }
  })

  scored.sort((a, b) => b.score - a.score)

  const startIdx = page * limit
  const feed = scored.slice(startIdx, startIdx + limit).map(({ post }) => ({
    post,
  }))

  const cursor = feed.length >= limit ? String(page + 1) : undefined

  return { cursor, feed }
}
