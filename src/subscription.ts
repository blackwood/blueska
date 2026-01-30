import { sql } from 'kysely'
import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'

const SKA_PATTERNS = [
  /\bska\b/i,
  /\bska[-\s]?punk\b/i,
  /\b2[-\s]?tone\b/i,
  /\btwo[-\s]?tone\b/i,
  /\brock[-\s]?steady\b/i,
  /\brude[-\s]?(boy|girl)\b/i,
  /\bskank(ing)?\b/i,
  /\bthird[-\s]?wave\s+ska\b/i,
  /\bska[-\s]?core\b/i,
]

function isSkaRelated(text: string): boolean {
  return SKA_PATTERNS.some((pattern) => pattern.test(text))
}

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate = ops.posts.creates
      .filter((create) => isSkaRelated(create.record.text))
      .map((create) => ({
        uri: create.uri,
        cid: create.cid,
        indexedAt: new Date().toISOString(),
        likeCount: 0,
      }))

    // Track likes on posts we've indexed
    const likeSubjects = ops.likes.creates.map((like) => like.record.subject.uri)
    if (likeSubjects.length > 0) {
      await this.db
        .updateTable('post')
        .set({ likeCount: sql`likeCount + 1` })
        .where('uri', 'in', likeSubjects)
        .execute()
    }

    // Decrement like counts for deleted likes
    const unlikeSubjects = ops.likes.deletes.map((del) => {
      // Extract the post URI from the like URI (likes reference their subject)
      // Like URIs are at://<did>/app.bsky.feed.like/<rkey>, we need the subject
      // Unfortunately we don't have the subject URI for deletes, so we skip this
      return null
    }).filter(Boolean)

    if (postsToDelete.length > 0) {
      await this.db
        .deleteFrom('post')
        .where('uri', 'in', postsToDelete)
        .execute()
    }
    if (postsToCreate.length > 0) {
      await this.db
        .insertInto('post')
        .values(postsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }
}
