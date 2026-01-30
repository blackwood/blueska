import { sql } from 'kysely'
import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'

// TODO: Make this the most advanced skalgorithm on the planet
// Future ideas:
// - ML-based ska detection (train on ska lyrics/discussions)
// - Image recognition for checkerboard patterns, ska band shirts
// - Audio analysis for upstrokes and horn sections
// - Ska artist social graph analysis
// - Regional ska scene detection
// - Ska subgenre classification (traditional, 2-tone, third wave, ska-punk, etc.)

// High-confidence patterns - always match
const HIGH_CONFIDENCE_PATTERNS = [
  /\bska[-\s]?punk\b/i,
  /\bska[-\s]?core\b/i,
  /\bthird[-\s]?wave\s+ska\b/i,
  /\brock[-\s]?steady\b/i,
  /\bskankin[g']?\b/i,
  /\brudeboy\b/i,
  /\brudegirl\b/i,
  /\b(2|two)[-\s]?tone\s+ska\b/i,
  /#ska\b/i,
  // Notable ska bands
  /\b(the\s+)?specials\b/i,
  /\b(the\s+)?selecter\b/i,
  /\b(the\s+)?skatalites\b/i,
  /\bmadness\b/i,
  /\boperation\s+ivy\b/i,
  /\bless\s+than\s+jake\b/i,
  /\bstreetlight\s+manifesto\b/i,
  /\breel\s+big\s+fish\b/i,
  /\bmighty\s+mighty\s+bosstones\b/i,
  /\bsave\s+ferris\b/i,
  /\bgoldfinger\b/i,
  /\btoots\s+(and|&)\s+(the\s+)?maytals\b/i,
  /\bdesmond\s+dekker\b/i,
  /\bbad\s+manners\b/i,
  /\bthe\s+beat\b.*\bska\b/i,
]

// Music context words that validate ambiguous terms
const MUSIC_CONTEXT = /\b(band|bands|music|song|songs|album|albums|track|tracks|record|records|vinyl|playlist|listen|listening|heard|concert|concerts|show|shows|gig|gigs|tour|touring|live|genre|sound|sounds|horns|brass|trumpet|trombone|saxophone|upstroke|offbeat)\b/i

// Swedish "ska" patterns to exclude (ska + common Swedish verb infinitives)
const SWEDISH_SKA_PATTERNS = [
  /\bska\s+(vara|göra|ha|bli|ta|komma|se|få|kunna|vilja|gå|säga|veta|tro|börja|sluta|försöka|behöva|finnas|heta|verka|känna|leva|dö|äta|dricka|sova|jobba|arbeta|spela|läsa|skriva|köpa|sälja|hjälpa|hända|prata|titta|lyssna|träffa|möta|visa|ge|hålla|stå|sitta|ligga|springa|flyga|köra|resa|bo|flytta)\b/i,
  /\b(jag|du|han|hon|vi|de|den|det|man|ni)\s+ska\b/i,
  /\bska\s+(vi|du|jag|ni|han|hon|de|man)\b/i,
  /\bdet\s+ska\b/i,
  /\bsom\s+ska\b/i,
  /\batt\s+ska\b/i,
  /\boch\s+ska\b/i,
]

// Other non-music "ska" patterns
const EXCLUDE_PATTERNS = [
  /\bpolska\b/i,  // Polish dance or "Polish" in Swedish
]

function isSkaRelated(text: string): boolean {
  // Check high-confidence patterns first
  if (HIGH_CONFIDENCE_PATTERNS.some((p) => p.test(text))) {
    return true
  }

  // Check for excluded patterns
  if (EXCLUDE_PATTERNS.some((p) => p.test(text))) {
    return false
  }

  const hasStandaloneSka = /\bska\b/i.test(text)
  const hasTwoTone = /\b(2|two)[-\s]?tone\b/i.test(text)
  const hasRudeBoyGirl = /\brude[-\s]?(boy|girl)\b/i.test(text)

  // For standalone "ska", check it's not Swedish
  if (hasStandaloneSka) {
    const isSwedish = SWEDISH_SKA_PATTERNS.some((p) => p.test(text))
    if (isSwedish) {
      return false
    }
    // Standalone ska with music context
    if (MUSIC_CONTEXT.test(text)) {
      return true
    }
  }

  // "two tone" or "rude boy/girl" need music context (could be fashion/style otherwise)
  if ((hasTwoTone || hasRudeBoyGirl) && MUSIC_CONTEXT.test(text)) {
    return true
  }

  // Standalone ska without Swedish patterns - allow if it looks like ska is the focus
  // e.g., "love ska", "ska forever", "ska is great"
  if (hasStandaloneSka && /\b(love|loving|into|obsessed|favorite|favourite|best|great|awesome)\s+(ska|this)\b/i.test(text)) {
    return true
  }

  return false
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
