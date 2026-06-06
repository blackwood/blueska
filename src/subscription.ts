import { sql } from 'kysely'
import { JetstreamSubscriptionBase, JetstreamEvent } from './util/jetstream'
import {
  computeLexiconScore,
  LEXICON_SCORE_VERSION,
} from './util/lexiconScore'

// High-confidence patterns — always match, no context needed
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
  // Unambiguous band/artist names (specific enough to not need context)
  /\b(the\s+)?skatalites\b/i,
  /\boperation\s+ivy\b/i,
  /\bless\s+than\s+jake\b/i,
  /\bstreetlight\s+manifesto\b/i,
  /\breel\s+big\s+fish\b/i,
  /\bmighty\s+mighty\s+bosstones\b/i,
  /\btoots\s+(and|&)\s+(the\s+)?maytals\b/i,
  /\bdesmond\s+dekker\b/i,
  /\bthe\s+beat\b.*\bska\b/i,
]

// Band names that are also common words — require music context to match.
// Case-sensitive where the band name is a proper noun (capital) but the
// common word almost always appears lowercase.
const AMBIGUOUS_BAND_PATTERNS = [
  /\bthe\s+specials\b/i,
  /\b(the\s+)?selecter\b/i,
  /\bMadness\b/,              // case-sensitive: lowercase "madness" = common word
  /\bsave\s+ferris\b/i,
  /\bgoldfinger\b/i,
  /\bBad\s+Manners\b/,        // case-sensitive: lowercase "bad manners" = common phrase
]

// Music context words that validate ambiguous terms
const MUSIC_CONTEXT =
  /\b(band|bands|music|song|songs|album|albums|track|tracks|record|records|vinyl|playlist|listen|listening|heard|concert|concerts|show|shows|gig|gigs|tour|touring|live|genre|sound|sounds|horns|brass|trumpet|trombone|saxophone|upstroke|offbeat)\b/i

// English music loanwords that appear even in non-English ska posts
const ENGLISH_MUSIC_SIGNALS =
  /\b(gig|gigs|show|shows|band|bands|concert|live|vinyl|ep|lp|bandcamp|spotify|soundcloud|tour|touring|skanking|skank|setlist|encore|venue|merch|lineup|festival|soundcheck|rehearsal|jam|riff)\b/i

// Swedish/Norwegian "ska" as modal verb: detected via surrounding grammar
const NORDIC_SKA_PATTERNS = [
  // Swedish subject + ska (jag/du/han/hon/vi/de/ni + ska)
  /\b(jag|du|han|hon|vi|de|den|det|man|ni)\s+ska\b/i,
  // ska + Swedish/Norse modal infinitives
  /\bska\s+(vara|göra|ha|bli|ta|komma|se|få|kunna|vilja|gå|säga|veta|tro|börja|sluta|försöka|behöva|finnas|heta|verka|känna|leva|dö|äta|dricka|sova|jobba|arbeta|spela|läsa|skriva|köpa|sälja|hjälpa|hända|prata|titta|lyssna|träffa|möta|visa|ge|hålla|stå|sitta|ligga|springa|flyga|köra|resa|bo|flytta)\b/i,
  // inverted: ska du/vi/jag
  /\bska\s+(vi|du|jag|ni|han|hon|de|man)\b/i,
  // common Norwegian modal: skal + infinitive marker
  /\bskal\s+(du|vi|jeg|dere|han|hun|de|man)\b/i,
  /\b(jeg|du|han|hun|vi|de|dere|man)\s+skal\b/i,
  // Swedish connectives tightly coupling ska
  /\b(det|som|att|och)\s+ska\b/i,
]

// Substring exclusions (word-boundary-agnostic fragments already filtered above)
const EXCLUDE_PATTERNS = [
  /\bpolska\b/i, // Polish dance / "Polish" in Swedish
  /\$ska\b/i, // crypto token
  /\bska\s+(coin|token|crypto|airdrop)\b/i,
  /\b(alaska|nebraska|itasca)\b/i,
]

function isSkaRelated(text: string): boolean {
  // High-confidence: always pass
  if (HIGH_CONFIDENCE_PATTERNS.some((p) => p.test(text))) {
    return true
  }

  // Hard exclusions
  if (EXCLUDE_PATTERNS.some((p) => p.test(text))) {
    return false
  }

  const hasStandaloneSka = /\bska\b/i.test(text)
  const hasTwoTone = /\b(2|two)[-\s]?tone\b/i.test(text)
  const hasRudeBoyGirl = /\brude[-\s]?(boy|girl)\b/i.test(text)

  // Ambiguous band names require music context
  if (AMBIGUOUS_BAND_PATTERNS.some((p) => p.test(text))) {
    if (MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text)) {
      return true
    }
  }

  if (hasStandaloneSka) {
    // Filter out Nordic grammar patterns
    if (NORDIC_SKA_PATTERNS.some((p) => p.test(text))) {
      // Only rescue if there are English music signals (bilingual ska posts)
      return ENGLISH_MUSIC_SIGNALS.test(text)
    }
    // Non-Nordic standalone ska → require at least music context or music signal
    return MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text)
  }

  if ((hasTwoTone || hasRudeBoyGirl) && MUSIC_CONTEXT.test(text)) {
    return true
  }

  return false
}

export class FirehoseSubscription extends JetstreamSubscriptionBase {
  async handleEvent(evt: JetstreamEvent) {
    if (evt.kind !== 'commit' || !evt.commit) return
    try {
      await this.processEvent(evt)
    } catch (err) {
      console.error('firehose write error (dropping event):', err)
    }
  }

  private async processEvent(evt: JetstreamEvent) {
    const { commit } = evt!
    const uri = `at://${evt.did}/${commit!.collection}/${commit!.rkey}`

    if (commit!.collection === 'app.bsky.feed.post') {
      if (commit!.operation === 'delete') {
        await this.db.deleteFrom('post').where('uri', '=', uri).execute()
      } else if (commit!.operation === 'create' && commit!.record) {
        const text = (commit!.record['text'] as string) ?? ''
        if (isSkaRelated(text)) {
          await this.db
            .insertInto('post')
            .values({
              uri,
              cid: commit!.cid ?? '',
              authorDid: evt.did,
              indexedAt: new Date().toISOString(),
              likeCount: 0,
              lexiconScore: computeLexiconScore(text),
              scoreVersion: LEXICON_SCORE_VERSION,
            })
            .onConflict((oc) => oc.doNothing())
            .execute()
        }
      }
    } else if (commit!.collection === 'app.bsky.feed.like') {
      if (commit!.operation === 'create' && commit!.record) {
        const subject = commit!.record['subject'] as
          | { uri?: string }
          | undefined
        const subjectUri = subject?.uri
        if (subjectUri) {
          // Only track likes on posts we've indexed — storing all firehose likes fills the DB
          const updated = await this.db
            .updateTable('post')
            .set({ likeCount: sql`likeCount + 1` })
            .where('uri', '=', subjectUri)
            .executeTakeFirst()
          if (Number(updated.numUpdatedRows) > 0) {
            await this.db
              .insertInto('like')
              .values({ uri, subjectUri })
              .onConflict((oc) => oc.doNothing())
              .execute()
          }
        }
      } else if (commit!.operation === 'delete') {
        const likeRow = await this.db
          .selectFrom('like')
          .select('subjectUri')
          .where('uri', '=', uri)
          .executeTakeFirst()
        if (likeRow) {
          await this.db
            .updateTable('post')
            .set({ likeCount: sql`MAX(0, likeCount - 1)` })
            .where('uri', '=', likeRow.subjectUri)
            .execute()
          await this.db.deleteFrom('like').where('uri', '=', uri).execute()
        }
      }
    }
  }
}
