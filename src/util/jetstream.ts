import WebSocket from 'ws'
import { Database } from '../db'

export type JetstreamCommit = {
  rev: string
  operation: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  record?: Record<string, unknown>
  cid?: string
}

export type JetstreamEvent = {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account'
  commit?: JetstreamCommit
}

// Jetstream time_us values are ~1.7×10¹⁵ µs. Old ATProto seq numbers are orders of magnitude smaller.
// If the stored cursor looks like an old seq number, start fresh from the live stream.
const MIN_JETSTREAM_CURSOR = 1_000_000_000_000_000

export abstract class JetstreamSubscriptionBase {
  private stopped = false
  public lastEventAt = 0

  constructor(public db: Database, public service: string) {}

  abstract handleEvent(evt: JetstreamEvent): Promise<void>

  async run(subscriptionReconnectDelay: number) {
    this.stopped = false
    const cursor = await this.getCursor()
    const url =
      cursor !== undefined && cursor > MIN_JETSTREAM_CURSOR
        ? `${this.service}&cursor=${cursor}`
        : this.service

    const ws = new WebSocket(url)
    let eventCount = 0

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const evt: JetstreamEvent = JSON.parse(data.toString())
        this.lastEventAt = Date.now()
        this.handleEvent(evt).catch((err) => {
          console.error('jetstream could not handle message', err)
        })
        if (evt.time_us && ++eventCount % 20 === 0) {
          this.updateCursor(evt.time_us).catch((err) => {
            console.error('jetstream could not update cursor', err)
          })
        }
      } catch (err) {
        console.error('jetstream failed to parse message', err)
      }
    })

    ws.on('error', (err) => {
      console.error('jetstream subscription error', err)
    })

    ws.on('close', () => {
      if (!this.stopped) {
        console.error('jetstream subscription closed, reconnecting...')
        setTimeout(
          () => this.run(subscriptionReconnectDelay),
          subscriptionReconnectDelay,
        )
      }
    })
  }

  stop() {
    this.stopped = true
  }

  async updateCursor(cursor: number) {
    await this.db
      .insertInto('sub_state')
      .values({ service: this.service, cursor })
      .onConflict((oc) => oc.doUpdateSet({ cursor }))
      .execute()
  }

  async getCursor(): Promise<number | undefined> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()
    return res?.cursor
  }
}
