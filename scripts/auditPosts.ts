// Checks indexed posts against the current gate and reports stale false positives.
//
// Keyword posts: re-runs isSkaRelated() — any that now fail are false positives.
// Affinity posts: checks posts from posts_only/metered accounts for replies
//   (replies from those accounts should not be in the feed).
//
// Usage: yarn auditPosts [--sql] [--limit=N]
//
//   --sql      Output DELETE SQL instead of a human-readable report
//   --limit=N  Only check the N most recently indexed keyword posts
//
// Typical prod workflow:
//   fly sftp get /data/blueska.db /tmp/blueska-prod.db
//   FEEDGEN_SQLITE_LOCATION=/tmp/blueska-prod.db yarn auditPosts
//   FEEDGEN_SQLITE_LOCATION=/tmp/blueska-prod.db yarn --silent auditPosts --sql \
//     | fly ssh console --command "sqlite3 /data/blueska.db"
//
// --silent is required when piping: suppresses yarn's banner from stdout.
//
// Note: affinity reply detection requires syncSceneGraph to have been run so
// the author_score table reflects current tiers.

import dotenv from 'dotenv'
import fs from 'fs'
import { createDb } from '../src/db'
import { isSkaRelated, isMentionSpam } from '../src/subscription'

dotenv.config()

const API = 'https://public.api.bsky.app/xrpc'

const args = process.argv.slice(2)
const SQL_MODE = args.includes('--sql')
const limitArg = args.find((a) => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined

type PostInfo = { text: string; isReply: boolean }

async function fetchPostInfo(uris: string[]): Promise<Map<string, PostInfo | null>> {
  const out = new Map<string, PostInfo | null>()
  for (let i = 0; i < uris.length; i += 25) {
    const batch = uris.slice(i, i + 25)
    const qs = batch.map((u) => `uris=${encodeURIComponent(u)}`).join('&')
    try {
      const res = await fetch(`${API}/app.bsky.feed.getPosts?${qs}`)
      if (!res.ok) {
        for (const u of batch) out.set(u, null)
        continue
      }
      const data = (await res.json()) as {
        posts: Array<{ uri: string; record?: { text?: string; reply?: unknown } }>
      }
      const found = new Set(data.posts.map((p) => p.uri))
      for (const u of batch) {
        if (!found.has(u)) out.set(u, null) // deleted on Bluesky
      }
      for (const p of data.posts) {
        out.set(p.uri, {
          text: p.record?.text ?? '',
          isReply: Boolean(p.record?.reply),
        })
      }
    } catch {
      for (const u of batch) out.set(u, null)
    }
  }
  return out
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function deleteSql(uri: string, ceiling: string): string {
  return `DELETE FROM post WHERE uri=${sqlStr(uri)} AND indexedAt<=${sqlStr(ceiling)};`
}

async function main() {
  const sqliteLocation = process.env.FEEDGEN_SQLITE_LOCATION ?? ''
  if (!sqliteLocation || sqliteLocation === ':memory:' || !fs.existsSync(sqliteLocation)) {
    console.error('Set FEEDGEN_SQLITE_LOCATION to an existing DB file.')
    process.exit(1)
  }

  const db = createDb(sqliteLocation)

  // Record the newest indexedAt as the safe delete ceiling: only delete posts
  // that existed when the DB was pulled, leaving anything indexed since untouched.
  const newestRow = await db
    .selectFrom('post')
    .select('indexedAt')
    .orderBy('indexedAt', 'desc')
    .limit(1)
    .executeTakeFirst()
  const pulledAt = newestRow?.indexedAt ?? new Date().toISOString()

  // ── 1. Keyword posts: re-run gate ──────────────────────────────────────────

  let q = db
    .selectFrom('post')
    .select(['uri', 'likeCount', 'indexedAt'])
    .where('inclusionReason', '=', 'keyword')
    .orderBy('indexedAt', 'desc')
  if (LIMIT) q = q.limit(LIMIT)
  const keywordPosts = await q.execute()

  if (!SQL_MODE) {
    const scope = LIMIT ? `most recent ${keywordPosts.length}` : `all ${keywordPosts.length}`
    console.log(`DB snapshot ceiling: ${pulledAt}`)
    process.stdout.write(`Fetching text for ${scope} keyword posts...`)
  }

  const keywordInfoMap = await fetchPostInfo(keywordPosts.map((p) => p.uri))
  if (!SQL_MODE) console.log(' done')

  type GateFail = { uri: string; likeCount: number; text: string }
  const gateFails: GateFail[] = []
  const deletedOnBsky: string[] = []

  for (const post of keywordPosts) {
    const info = keywordInfoMap.get(post.uri)
    if (info === null || info === undefined) {
      deletedOnBsky.push(post.uri)
      continue
    }
    if (info.text === '' || isMentionSpam(info.text) || !isSkaRelated(info.text)) {
      gateFails.push({ uri: post.uri, likeCount: post.likeCount, text: info.text })
    }
  }

  // ── 2. Affinity posts: detect replies from posts_only/metered accounts ─────
  // Requires syncSceneGraph to have been run so author_score.tier is current.

  const affinityPosts = await db
    .selectFrom('post')
    .innerJoin('author_score', 'post.authorDid', 'author_score.did')
    .select(['post.uri as uri', 'post.likeCount as likeCount', 'author_score.tier as tier'])
    .where('post.inclusionReason', '!=', 'keyword')
    .where((eb) => eb('author_score.tier', '=', 'posts_only').or('author_score.tier', '=', 'metered'))
    .execute()

  type ReplyFail = { uri: string; likeCount: number; tier: string }
  const replyFails: ReplyFail[] = []

  if (affinityPosts.length > 0) {
    if (!SQL_MODE) {
      process.stdout.write(`\nChecking ${affinityPosts.length} affinity posts for replies...`)
    }
    const affinityInfoMap = await fetchPostInfo(affinityPosts.map((p) => p.uri))
    if (!SQL_MODE) console.log(' done')

    for (const post of affinityPosts) {
      const info = affinityInfoMap.get(post.uri)
      if (info === null || info === undefined) {
        deletedOnBsky.push(post.uri)
        continue
      }
      if (info.isReply) {
        replyFails.push({ uri: post.uri, likeCount: post.likeCount, tier: post.tier })
      }
    }
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  const totalProblems = gateFails.length + replyFails.length + deletedOnBsky.length

  if (SQL_MODE) {
    if (totalProblems === 0) {
      process.stderr.write('-- Nothing to delete.\n')
      await db.destroy()
      return
    }
    console.log(`-- DB snapshot ceiling: ${pulledAt}`)
    console.log(`-- Posts indexed after this timestamp are safe on prod and will not be touched.\n`)

    if (gateFails.length > 0) {
      const withLikes = gateFails.filter((p) => p.likeCount > 0).length
      console.log(
        `-- ${gateFails.length} keyword gate failures (${withLikes} with likes, ${gateFails.length - withLikes} without)`,
      )
      for (const p of gateFails) console.log(deleteSql(p.uri, pulledAt))
    }

    if (replyFails.length > 0) {
      console.log(
        `\n-- ${replyFails.length} replies from posts_only/metered accounts`,
      )
      for (const p of replyFails) console.log(deleteSql(p.uri, pulledAt))
    }

    if (deletedOnBsky.length > 0) {
      console.log(`\n-- ${deletedOnBsky.length} posts deleted on Bluesky (orphaned in DB)`)
      for (const uri of deletedOnBsky) console.log(deleteSql(uri, pulledAt))
    }
  } else {
    console.log()

    if (gateFails.length === 0) {
      console.log(`All ${keywordPosts.length} keyword posts pass the current gate.`)
    } else {
      const withLikes = gateFails.filter((p) => p.likeCount > 0)
      const withoutLikes = gateFails.filter((p) => p.likeCount === 0)
      for (const p of gateFails) {
        const tag = p.likeCount > 0 ? `❤ ${p.likeCount}` : '0 likes'
        console.log(`[gate fail / ${tag}]  ${p.uri}`)
        console.log(`  "${p.text.slice(0, 140).replace(/\n/g, ' ')}"`)
        console.log()
      }
      console.log(`${gateFails.length} keyword gate failure(s) out of ${keywordPosts.length} checked`)
      console.log(`  ${withLikes.length} with likes — manual delete needed`)
      console.log(`  ${withoutLikes.length} without likes — will age out in ≤14 days`)
    }

    if (replyFails.length > 0) {
      console.log()
      for (const p of replyFails) {
        const tag = p.likeCount > 0 ? `❤ ${p.likeCount}` : '0 likes'
        console.log(`[reply from ${p.tier} / ${tag}]  ${p.uri}`)
      }
      console.log(`${replyFails.length} reply post(s) from posts_only/metered accounts`)
    }

    if (deletedOnBsky.length > 0) {
      console.log(`\n${deletedOnBsky.length} post(s) no longer exist on Bluesky (orphaned in DB)`)
    }

    if (totalProblems > 0) {
      console.log(`\nTo delete from prod:`)
      console.log(`  FEEDGEN_SQLITE_LOCATION=${sqliteLocation} yarn --silent auditPosts --sql \\`)
      console.log(`    | fly ssh console --command "sqlite3 /data/blueska.db"`)
    }
  }

  await db.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
