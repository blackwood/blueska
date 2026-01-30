import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

// max 15 chars
export const shortname = 'blueska'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const limit = params.limit
  const now = new Date()
  const freshWindow = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()

  // Parse cursor: "freshOffset:popularOffset"
  let freshOffset = 0
  let popularOffset = 0
  if (params.cursor) {
    const [f, p] = params.cursor.split(':')
    freshOffset = parseInt(f, 10) || 0
    popularOffset = parseInt(p, 10) || 0
  }

  // Fetch fresh posts (last 48 hours)
  const freshPosts = await ctx.db
    .selectFrom('post')
    .selectAll()
    .where('indexedAt', '>', freshWindow)
    .orderBy('indexedAt', 'desc')
    .offset(freshOffset)
    .limit(limit * 2)
    .execute()

  // Fetch popular posts (by like count)
  const popularPosts = await ctx.db
    .selectFrom('post')
    .selectAll()
    .where('likeCount', '>', 0)
    .orderBy('likeCount', 'desc')
    .orderBy('indexedAt', 'desc')
    .offset(popularOffset)
    .limit(limit)
    .execute()

  // Interleave: 3 fresh, 1 popular, repeat
  const seen = new Set<string>()
  const feed: { post: string }[] = []
  let freshIdx = 0
  let popularIdx = 0

  while (feed.length < limit) {
    // Add up to 3 fresh posts
    for (let i = 0; i < 3 && feed.length < limit; i++) {
      while (freshIdx < freshPosts.length && seen.has(freshPosts[freshIdx].uri)) {
        freshIdx++
      }
      if (freshIdx < freshPosts.length) {
        seen.add(freshPosts[freshIdx].uri)
        feed.push({ post: freshPosts[freshIdx].uri })
        freshIdx++
      }
    }

    // Add 1 popular post
    if (feed.length < limit) {
      while (popularIdx < popularPosts.length && seen.has(popularPosts[popularIdx].uri)) {
        popularIdx++
      }
      if (popularIdx < popularPosts.length) {
        seen.add(popularPosts[popularIdx].uri)
        feed.push({ post: popularPosts[popularIdx].uri })
        popularIdx++
      }
    }

    // If we've exhausted both lists, break
    if (freshIdx >= freshPosts.length && popularIdx >= popularPosts.length) {
      break
    }
  }

  // Build cursor for next page
  let cursor: string | undefined
  if (feed.length > 0) {
    cursor = `${freshOffset + freshIdx}:${popularOffset + popularIdx}`
  }

  return {
    cursor,
    feed,
  }
}
