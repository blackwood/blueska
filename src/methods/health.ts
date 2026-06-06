import express from 'express'
import fs from 'fs'
import { AppContext } from '../config'
import { JetstreamSubscriptionBase } from '../util/jetstream'

const FIREHOSE_STALE_SECONDS = 300 // 5 minutes without a message = degraded

export default function (
  ctx: AppContext,
  firehose: JetstreamSubscriptionBase,
): express.Router {
  const router = express.Router()

  router.get('/health', (_req, res) => {
    const now = Date.now()

    const firehoseLagSeconds =
      firehose.lastEventAt > 0
        ? Math.round((now - firehose.lastEventAt) / 1000)
        : null

    let dbSizeBytes: number | null = null
    if (ctx.cfg.sqliteLocation !== ':memory:') {
      try {
        dbSizeBytes = fs.statSync(ctx.cfg.sqliteLocation).size
      } catch {
        // file not readable
      }
    }

    const degraded =
      firehoseLagSeconds !== null && firehoseLagSeconds > FIREHOSE_STALE_SECONDS

    res.json({
      status: degraded ? 'degraded' : 'ok',
      firehoseLagSeconds,
      dbSizeBytes,
    })
  })

  return router
}
