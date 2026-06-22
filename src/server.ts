import http from 'http'
import events from 'events'
import fs from 'fs'
import express from 'express'
import { sql } from 'kysely'
import { DidResolver, MemoryCache } from '@atproto/identity'
import { createServer } from './lexicon'
import feedGeneration from './methods/feed-generation'
import describeGenerator from './methods/describe-generator'
import health from './methods/health'
import { createDb, Database, migrateToLatest } from './db'
import { FirehoseSubscription } from './subscription'
import { AppContext, Config } from './config'
import wellKnown from './well-known'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public db: Database
  public firehose: FirehoseSubscription
  public cfg: Config

  constructor(
    app: express.Application,
    db: Database,
    firehose: FirehoseSubscription,
    cfg: Config,
  ) {
    this.app = app
    this.db = db
    this.firehose = firehose
    this.cfg = cfg
  }

  static create(cfg: Config) {
    const app = express()
    const db = createDb(cfg.sqliteLocation)
    const firehose = new FirehoseSubscription(db, cfg.subscriptionEndpoint)

    const didCache = new MemoryCache()
    const didResolver = new DidResolver({
      plcUrl: 'https://plc.directory',
      didCache,
    })

    const server = createServer({
      validateResponse: true,
      payload: {
        jsonLimit: 100 * 1024, // 100kb
        textLimit: 100 * 1024, // 100kb
        blobLimit: 5 * 1024 * 1024, // 5mb
      },
    })
    const ctx: AppContext = {
      db,
      didResolver,
      cfg,
    }
    feedGeneration(server, ctx)
    describeGenerator(server, ctx)
    app.use(server.xrpc.router)
    app.use(wellKnown(ctx))
    app.use(health(ctx, firehose))

    return new FeedGenerator(app, db, firehose, cfg)
  }

  async start(): Promise<http.Server> {
    // Bind first so health checks pass immediately during migrations
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    await migrateToLatest(this.db)
    await this.firehose.loadAuthorAffinity()
    this.firehose.run(this.cfg.subscriptionReconnectDelay)
    this.startRetentionJob()
    return this.server
  }

  private startRetentionJob() {
    const prune = async () => {
      try {
        const cutoff = new Date(
          Date.now() - 14 * 24 * 60 * 60 * 1000,
        ).toISOString()
        const result = await this.db
          .deleteFrom('post')
          .where('indexedAt', '<', cutoff)
          .where('likeCount', '=', 0)
          .executeTakeFirst()
        if (Number(result.numDeletedRows) > 0) {
          console.log(`retention: pruned ${result.numDeletedRows} old posts`)
        }
        // Delete likes whose subject posts have been pruned.
        // LEFT JOIN + separate DELETE avoids SQLite materializing a NOT IN subquery
        // on the same table (which scans all rows on every batch iteration).
        while (true) {
          const orphans = await this.db
            .selectFrom('like')
            .leftJoin('post', 'post.uri', 'like.subjectUri')
            .select('like.uri')
            .where('post.uri', 'is', null)
            .limit(500)
            .execute()
          if (orphans.length === 0) break
          await this.db
            .deleteFrom('like')
            .where('uri', 'in', orphans.map((r) => r.uri))
            .execute()
          await new Promise((resolve) => setImmediate(resolve))
        }
        await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(this.db)
        // Log component distributions so we can verify they're on comparable
        // scales before trusting the composite weights in blueska.ts.
        try {
          const stats = await this.db
            .selectFrom('post')
            .select((eb) => [
              eb.fn.countAll().as('total'),
              eb.fn.avg('likeCount').as('avgLikes'),
              eb.fn.max('likeCount').as('maxLikes'),
              eb.fn.avg('lexiconScore').as('avgLexicon'),
              eb.fn.min('lexiconScore').as('minLexicon'),
              eb.fn.max('lexiconScore').as('maxLexicon'),
            ])
            .executeTakeFirst()
          console.log('feed stats:', JSON.stringify(stats))
        } catch {
          // non-fatal
        }

        if (this.cfg.sqliteLocation !== ':memory:') {
          try {
            const sizeMB = Math.round(
              fs.statSync(this.cfg.sqliteLocation).size / 1024 / 1024,
            )
            console.log(`retention: db size ${sizeMB}MB`)
            if (sizeMB > 3000) {
              console.warn(
                `retention: db size ${sizeMB}MB exceeds 3GB — check disk usage`,
              )
            }
          } catch {
            // stat failed
          }
        }
      } catch (err) {
        console.error('retention job error:', err)
      }
    }
    // Delay first run so health checks pass and deploy is confirmed before
    // any long-running synchronous SQLite operation blocks the event loop
    setTimeout(prune, 90_000)
    setInterval(prune, 60 * 60 * 1000)
  }
}

export default FeedGenerator
