// Backfills posts matching a hashtag that the firehose may have missed.
// Searches Bluesky's public API, then outputs INSERT SQL for prod.
//
// Usage:
//   yarn backfillHashtag [--tag=blueska] [--sql] [--since=2024-01-01]
//
//   --tag=NAME   Hashtag to search for (default: blueska)
//   --sql        Output INSERT SQL instead of inserting into local DB
//   --since=DATE Stop paginating once posts are older than this ISO date
//
// Typical workflow:
//   # Pull prod DB first so you can skip URIs already in the feed
//   fly sftp get /data/blueska.db /tmp/blueska-prod.db
//
//   # Preview what would be inserted
//   FEEDGEN_SQLITE_LOCATION=/tmp/blueska-prod.db yarn backfillHashtag
//
//   # Generate SQL and apply to prod (--silent suppresses yarn banner from stdout)
//   FEEDGEN_SQLITE_LOCATION=/tmp/blueska-prod.db yarn --silent backfillHashtag --sql \
//     | fly ssh console --command "sqlite3 /data/blueska.db"
//
// INSERT OR IGNORE is used so duplicate URIs are silently skipped on prod.
//
// Requires auth: set BSKY_IDENTIFIER and BSKY_APP_PASSWORD in .env
// (generate an app password at https://bsky.app/settings/app-passwords)

import dotenv from 'dotenv'
import fs from 'fs'
import { AtpAgent } from '@atproto/api'
import { createDb } from '../src/db'
import { computeLexiconScore, LEXICON_SCORE_VERSION } from '../src/util/lexiconScore'

dotenv.config()

const args = process.argv.slice(2)
const SQL_MODE = args.includes('--sql')
const tagArg = args.find((a) => a.startsWith('--tag='))
const TAG = tagArg ? tagArg.split('=')[1] : 'blueska'
const sinceArg = args.find((a) => a.startsWith('--since='))
const SINCE = sinceArg ? sinceArg.split('=')[1] : undefined

const agent = new AtpAgent({ service: 'https://bsky.social' })

function sqlLiteral(v: string | number): string {
  return typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v)
}

async function main() {
  const sqliteLocation = process.env.FEEDGEN_SQLITE_LOCATION ?? ''
  if (!sqliteLocation || sqliteLocation === ':memory:' || !fs.existsSync(sqliteLocation)) {
    console.error('Set FEEDGEN_SQLITE_LOCATION to an existing DB file.')
    process.exit(1)
  }

  const identifier = process.env.BSKY_IDENTIFIER ?? ''
  const appPassword = process.env.BSKY_APP_PASSWORD ?? ''
  if (!identifier || !appPassword) {
    console.error('Set BSKY_IDENTIFIER and BSKY_APP_PASSWORD in .env')
    console.error('Generate an app password at https://bsky.app/settings/app-passwords')
    process.exit(1)
  }
  await agent.login({ identifier, password: appPassword })

  const db = createDb(sqliteLocation)

  if (!SQL_MODE) {
    console.log(`Searching for #${TAG} posts${SINCE ? ` since ${SINCE}` : ''}...`)
  } else {
    console.log(`-- Backfill: #${TAG} posts${SINCE ? ` since ${SINCE}` : ''}`)
    console.log(`-- Generated ${new Date().toISOString()}\n`)
  }

  let cursor: string | undefined
  let found = 0
  let inserted = 0
  let skipped = 0
  let stopped = false

  do {
    const res = await agent.app.bsky.feed.searchPosts({ q: `#${TAG}`, limit: 100, cursor })
    const { posts, cursor: nextCursor } = res.data
    cursor = nextCursor

    for (const post of posts) {
      found++
      const record = post.record as { text?: string; createdAt?: string }
      const text = record.text ?? ''
      const createdAt = record.createdAt ?? post.indexedAt ?? new Date().toISOString()

      if (SINCE && createdAt < SINCE) {
        stopped = true
        break
      }

      const uri = post.uri
      const cid = post.cid
      const authorDid = post.author.did
      const likeCount = post.likeCount ?? 0
      const lexiconScore = computeLexiconScore(text)

      if (SQL_MODE) {
        const cols = 'uri,cid,authorDid,indexedAt,likeCount,lexiconScore,scoreVersion,inclusionReason'
        const vals = [uri, cid, authorDid, createdAt, likeCount, lexiconScore, LEXICON_SCORE_VERSION, 'keyword']
          .map(sqlLiteral)
          .join(',')
        console.log(`INSERT OR IGNORE INTO post (${cols}) VALUES (${vals});`)
        inserted++
      } else {
        const result = await db
          .insertInto('post')
          .values({
            uri,
            cid,
            authorDid,
            indexedAt: createdAt,
            likeCount,
            lexiconScore,
            scoreVersion: LEXICON_SCORE_VERSION,
            inclusionReason: 'keyword',
          })
          .onConflict((oc) => oc.doNothing())
          .executeTakeFirst()
        if (!result.numInsertedOrUpdatedRows) {
          skipped++
        } else {
          inserted++
        }
      }
    }

    if (stopped || posts.length === 0) break
  } while (cursor)

  if (!SQL_MODE) {
    console.log(
      `Done: ${inserted} inserted, ${skipped} already in DB` +
        (stopped ? ` (stopped at --since=${SINCE})` : ''),
    )
  } else {
    const note = stopped ? ` (stopped at --since=${SINCE})` : ''
    process.stderr.write(`-- ${found} posts found, ${inserted} INSERT statements generated${note}\n`)
    process.stderr.write(
      `-- Pipe to prod:  yarn --silent backfillHashtag --sql | fly ssh console --command "sqlite3 /data/blueska.db"\n`,
    )
  }

  await db.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
