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
  /\bskankin[g']?\b/i,
  /\brudeboy\b/i,
  /\brudegirl\b/i,
  /\b(2|two)[-\s]?tone\s+ska\b/i,
  /#ska\b/i,
  /#blueska\b/i, // feed-specific tag: anyone using it is explicitly opting in
  // Unambiguous band/artist names (specific enough to not need context)
  /\bska[-\s]?(cover|version|remix|arrangement)\b/i,
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
  // Madness handled separately via classifyMadness() — not listed here
  /\bsave\s+ferris\b/i,
  /\bgoldfinger\b/i,
  /\bBad\s+Manners\b/,        // case-sensitive: lowercase "bad manners" = common phrase
  /\brock-?steady\b/i,    // moved from HIGH_CONFIDENCE: Rocksteady Studios / TMNT / political metaphor
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
  /\bska\s+(vara|göra|ha|bli|ta|komma|se|få|kunna|vilja|gå|säga|veta|tro|börja|sluta|försöka|behöva|finnas|heta|verka|känna|leva|dö|äta|dricka|sova|jobba|arbeta|spela|läsa|skriva|köpa|sälja|hjälpa|hända|prata|titta|lyssna|träffa|möta|visa|ge|hålla|stå|sitta|ligga|springa|flyga|köra|resa|bo|flytta|fram|dit|hem|bort|upp|ner|ned|tillbaka|vidare|iväg|loss)\b/i,
  // inverted: ska du/vi/jag
  /\bska\s+(vi|du|jag|ni|han|hon|de|man)\b/i,
  // common Norwegian modal: skal + infinitive marker
  /\bskal\s+(du|vi|jeg|dere|han|hun|de|man)\b/i,
  /\b(jeg|du|han|hun|vi|de|dere|man)\s+skal\b/i,
  // Swedish connectives tightly coupling ska
  /\b(det|som|att|och)\s+ska\b/i,
]

// Bond-film exclusion constants. Music context rescues all Bond checks.
const BOND_STRONG_RE = /\bjames bond\b|\bbond (film|movie)\b/i
const GOLDFINGER_RE = /\bgoldfinger\b/i
const GOLDFINGER_BOND_CTX_RE =
  /\bjames bond\b|\bbond (film|movie|villain|franchise|series)\b|\b007\b|\boddjob\b|\bauric\b|\bsean connery\b/i

// Substring exclusions — checked before ambiguous pattern tests
const EXCLUDE_PATTERNS = [
  /\bpolska\b/i, // Polish dance / "Polish" in Swedish
  /\$ska\b/i, // crypto token
  /\bska\s+(coin|token|crypto|airdrop)\b/i,
  /\b(alaska|nebraska|itasca)\b/i,
  // Slavic feminine surnames: "ńska", "śka", etc. — the non-ASCII consonant is \W
  // in JS, so \b fires before "ska" and \bska\b incorrectly matches (e.g. Jasińska).
  // Lookbehind catches exactly this: a Unicode letter immediately before the boundary.
  /(?<=\p{L})\bska\b/u,

  // Madness handled by classifyMadness() below — not listed here

  // Rocksteady Studios (Batman: Arkham games) and TMNT characters Bebop & Rocksteady
  /\b(arkham|rocksteady\s+studios?)\b/i,
  /\b(bebop|beebop)\b.*\brock[-\s]?steady\b|\brock[-\s]?steady\b.*\b(bebop|beebop)\b/i,

  // skanks+skanking co-occurrence handled by SKANKS_SKANKING_RE above isSkaRelated()
]

// Fraction of near-misses to log — 10% gives a representative sample without
// overwhelming stdout on a high-volume firehose. Grep fly logs for "nearMiss".
const NEAR_MISS_SAMPLE_RATE = 0.1

// ---- Madness structural classifier ----------------------------------------
// Distinguishes Madness (ska band) from compound proper nouns, titles, and
// forced sentence-initial capitals. Ported from scripts/madness_filter.py.
//
//   HIGH   (≥ 0.70) — mid-sentence standalone capital: confidently the band
//   MEDIUM (≥ 0.45) — sentence-initial or lightly flanked: pass to context gate
//   LOW    (≥ 0.25) — single adjacent proper noun: probably not the band
//   REJECT (< 0.25) — flanked by 2+, known collocation, or quoted: not the band
//
// Key fix over the old regex approach: direct-adjacency phrases like "March Madness"
// are caught via flankCount (no connective required), and coordinators like "and"
// stop the scan so "Madness and Blur" doesn't penalise Madness.

// Glue words scanned across when measuring flanking proper nouns.
const _MC = new Set([
  'a', 'an', 'as', 'at', 'by', 'down', 'for', 'from', 'if', 'in',
  'into', 'like', 'near', 'of', 'off', 'on', 'once', 'onto', 'over',
  'past', 'than', 'that', 'the', 'to', 'upon', 'when', 'with',
  'de', 'del', 'la', 'le', 'du',
])
// Coordinators stop the scan — they separate list items, not phrase parts.
const _MCOORD = new Set(['and', 'or', 'nor', 'but', 'so', 'yet'])
const _MSEND = new Set(['.', '!', '?'])
const _MQ = new Set(['"', '“', '”', '‘', '’', "'"])
// Direct left-adjacency collocations that are always false positives.
const _MLEFT = new Set(['march'])
const _MTOK = /[A-Za-z][A-Za-z'’]*|[.,;:!?]/g

function _mToks(text: string): Array<[string, number]> {
  const re = new RegExp(_MTOK.source, 'g')
  const out: Array<[string, number]> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push([m[0], m.index])
  return out
}

function _mQSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let open: number | null = null
  for (let i = 0; i < text.length; i++) {
    if (_MQ.has(text[i])) {
      if (open === null) open = i
      else { spans.push([open, i]); open = null }
    }
  }
  return spans
}

function _mFlank(toks: Array<[string, number]>, i: number, dir: -1 | 1): number {
  let count = 0, j = i + dir
  while (j >= 0 && j < toks.length) {
    const w = toks[j][0]
    if (!/^[A-Za-z]/.test(w)) break
    const wl = w.toLowerCase()
    if (_MCOORD.has(wl) || wl === 'i') break
    if (_MC.has(wl)) { j += dir; continue }
    if (w[0] >= 'A' && w[0] <= 'Z') { count++; j += dir; continue }
    break
  }
  return count
}

function _mSentInit(toks: Array<[string, number]>, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const t = toks[k][0]
    if (_MQ.has(t)) continue
    if (!/^[A-Za-z]/.test(t)) return _MSEND.has(t)
    return false
  }
  return true
}

function classifyMadness(text: string): 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT' {
  const toks = _mToks(text)
  const qspans = _mQSpans(text)
  const rank = { REJECT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 } as const
  let best: 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT' = 'REJECT'

  for (let i = 0; i < toks.length; i++) {
    const [tok, start] = toks[i]
    if (tok.toLowerCase() !== 'madness') continue
    if (!(tok[0] >= 'A' && tok[0] <= 'Z')) continue  // lowercase → not the band

    let score = 0.5
    const inQ = qspans.some(([s, e]) => s < start && start < e)
    if (inQ) score -= 0.35

    const L = _mFlank(toks, i, -1)
    const R = _mFlank(toks, i, 1)
    if (L + R >= 2) score -= 0.45
    else if (L + R === 1) score -= 0.28

    if (i > 0 && /^[A-Za-z]/.test(toks[i - 1][0])) {
      if (_MLEFT.has(toks[i - 1][0].toLowerCase())) score -= 0.5
    }

    const sentInit = _mSentInit(toks, i)
    if (!sentInit && L + R === 0 && !inQ) score += 0.35
    if (sentInit) score = Math.min(score, 0.55)
    score = Math.max(0, Math.min(1, score))

    const tier: 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT' =
      score >= 0.70 ? 'HIGH' : score >= 0.45 ? 'MEDIUM' : score >= 0.25 ? 'LOW' : 'REJECT'
    if (rank[tier] > rank[best]) best = tier
  }
  return best
}
// ---- end Madness classifier ------------------------------------------------

// Returns a reason tag if the post had some ska-adjacent signal but was rejected,
// or null if it had no signal at all (no point logging pure noise).
function nearMissReason(text: string, isReply: boolean): string | null {
  const hasHighConf = HIGH_CONFIDENCE_PATTERNS.some((p) => p.test(text))
  const hasAmbiguous = AMBIGUOUS_BAND_PATTERNS.some((p) => p.test(text))
  const hasMadness = /\bMadness\b/.test(text)
  const hasSka = /\bska\b/i.test(text)
  const hasTwoTone = /\b(2|two)[-\s]?tone\b/i.test(text)
  const hasRudeBoyGirl = /\brude[-\s]?(boy|girl)\b/i.test(text)

  if (!hasHighConf && !hasAmbiguous && !hasMadness && !hasSka && !hasTwoTone && !hasRudeBoyGirl) {
    return null // no ska signal at all — not a near-miss
  }

  const madnessTier = hasMadness ? classifyMadness(text) : null
  const madnessExcluded = madnessTier === 'LOW' || madnessTier === 'REJECT'
  const madnessAmbiguous = madnessTier === 'MEDIUM' || madnessTier === 'HIGH'

  // Exclusion fired despite a positive signal — highest audit priority
  if (EXCLUDE_PATTERNS.some((p) => p.test(text)) || madnessExcluded) {
    if (hasHighConf) return 'exclude:high_confidence'
    if (hasAmbiguous || madnessExcluded) return 'exclude:ambiguous_band'
    if (hasSka) return 'exclude:ska'
    return 'exclude:other'
  }

  // Reply gate blocked it — would have passed the full gate on a root post
  if (isReply && !hasHighConf) {
    if (hasAmbiguous || hasMadness) return 'reply:ambiguous_band'
    if (hasSka) return 'reply:ska'
    return 'reply:other'
  }

  // Ambiguous band matched but no music context
  if ((hasAmbiguous || madnessAmbiguous) && !MUSIC_CONTEXT.test(text) && !ENGLISH_MUSIC_SIGNALS.test(text)) {
    return 'ambiguous:no_context'
  }

  // Standalone ska blocked by Nordic grammar
  if (hasSka && NORDIC_SKA_PATTERNS.some((p) => p.test(text))) {
    return 'ska:nordic'
  }

  // Standalone ska but no music context
  if (hasSka && !MUSIC_CONTEXT.test(text) && !ENGLISH_MUSIC_SIGNALS.test(text)) {
    return 'ska:no_context'
  }

  // Two-tone / rude boy without music context
  if ((hasTwoTone || hasRudeBoyGirl) && !MUSIC_CONTEXT.test(text)) {
    return 'two_tone_or_rude:no_context'
  }

  return 'unknown'
}

// Must be checked before HIGH_CONFIDENCE because "skanking" is high-confidence
// but the co-occurrence with derogatory "skanks" overrides it.
const SKANKS_SKANKING_RE = /\bskanks?\b.*\bskanking\b|\bskanking\b.*\bskanks?\b/i

// Structural spam: posts where @mentions + #hashtags dominate the content.
// Floor of 3 mentions before ratio kicks in — normal posts rarely exceed this.
const MENTION_SPAM_FLOOR = 3
const MENTION_SPAM_RATIO = 0.6

export function isMentionSpam(text: string): boolean {
  const mentions = (text.match(/@[\w.:-]+/g) ?? []).length
  if (mentions < MENTION_SPAM_FLOOR) return false
  const hashtags = (text.match(/#\w+/g) ?? []).length
  const noise = mentions + hashtags
  const prose = text.replace(/@[\w.:-]+/g, '').replace(/#\w+/g, '')
  const proseWords = (prose.match(/\b[a-zA-Z]{2,}\b/g) ?? []).length
  return noise / (noise + proseWords) >= MENTION_SPAM_RATIO
}

export function isSkaRelated(text: string): boolean {
  // Hard override: derogatory "skanks" co-occurring with "skanking" — checked
  // before HIGH_CONFIDENCE so it isn't bypassed by the skanking pattern.
  if (SKANKS_SKANKING_RE.test(text)) return false

  // High-confidence: always pass
  if (HIGH_CONFIDENCE_PATTERNS.some((p) => p.test(text))) {
    return true
  }

  // Madness requires structural classification to distinguish the band from
  // compound proper nouns (March Madness, Sound of Madness, Midnight Madness).
  // Handled before the generic exclusion/ambiguous passes.
  if (/\bMadness\b/.test(text)) {
    const tier = classifyMadness(text)
    if (tier === 'HIGH') return true
    if (tier === 'MEDIUM' && (MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text))) return true
    // LOW/REJECT: signal suppressed — fall through to other checks
  }

  // Hard exclusions
  if (EXCLUDE_PATTERNS.some((p) => p.test(text))) {
    return false
  }

  const hasStandaloneSka = /\bska\b/i.test(text)
  const hasTwoTone = /\b(2|two)[-\s]?tone\b/i.test(text)
  const hasRudeBoyGirl = /\brude[-\s]?(boy|girl)\b/i.test(text)

  // Bond-film signals — exclude unless music context is present.
  const hasMusicCtx = MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text)
  if (BOND_STRONG_RE.test(text) && !hasMusicCtx) return false
  if (GOLDFINGER_RE.test(text) && GOLDFINGER_BOND_CTX_RE.test(text) && !hasMusicCtx) return false

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

const AUTHOR_AFFINITY_THRESHOLD = 0.5

export class FirehoseSubscription extends JetstreamSubscriptionBase {
  private authorAffinity = new Map<string, { score: number; tier: string }>()

  async loadAuthorAffinity(): Promise<void> {
    const rows = await this.db
      .selectFrom('author_score')
      .select(['did', 'score', 'tier'])
      .execute()
    this.authorAffinity = new Map(rows.map((r) => [r.did, { score: r.score, tier: r.tier }]))
    console.log(
      `author affinity: loaded ${this.authorAffinity.size} accounts (threshold ${AUTHOR_AFFINITY_THRESHOLD})`,
    )
  }

  // Returns the account's affinity tier if it should bypass the keyword gate
  // for this post, or null if not eligible.
  //   full       — root posts + replies indexed
  //   posts_only — root posts only; replies still need keyword gate
  //   metered    — root posts only; algo applies 1-per-page cap + like threshold
  // Content exclusions (Madness compound nouns, TMNT, etc.) block all tiers.
  private getAffinityTier(did: string, text: string): 'full' | 'posts_only' | 'metered' | null {
    const entry = this.authorAffinity.get(did)
    if (!entry || entry.score < AUTHOR_AFFINITY_THRESHOLD) return null
    if (SKANKS_SKANKING_RE.test(text)) return null
    if (EXCLUDE_PATTERNS.some((p) => p.test(text))) return null
    const hasMusicCtx = MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text)
    if (BOND_STRONG_RE.test(text) && !hasMusicCtx) return null
    if (GOLDFINGER_RE.test(text) && GOLDFINGER_BOND_CTX_RE.test(text) && !hasMusicCtx) return null
    if (/\bMadness\b/.test(text)) {
      const tier = classifyMadness(text)
      if (tier === 'LOW' || tier === 'REJECT') return null
    }
    return entry.tier as 'full' | 'posts_only' | 'metered'
  }

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
        // Hard-blocked accounts: totally excluded before any gate logic
        if (this.authorAffinity.get(evt.did)?.tier === 'blocked') return

        const text = (commit!.record['text'] as string) ?? ''

        // Structural spam: @mention flood — skip before semantic checks
        if (isMentionSpam(text)) return
        // Replies lack parent context — require a standalone high-confidence signal
        // rather than the looser standalone-ska + music-context gate.
        const isReply = Boolean(commit!.record['reply'])
        const keywordMatch = isReply
          ? HIGH_CONFIDENCE_PATTERNS.some((p) => p.test(text))
          : isSkaRelated(text)
        // Affinity bypass: full tier bypasses root + replies; posts_only and metered bypass root only.
        const affinityTier = !keywordMatch ? this.getAffinityTier(evt.did, text) : null
        const affinityMatch = affinityTier !== null && (!isReply || affinityTier === 'full')
        if (keywordMatch || affinityMatch) {
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
              inclusionReason: keywordMatch ? 'keyword' : affinityTier!,
            })
            .onConflict((oc) => oc.doNothing())
            .execute()
        } else if (Math.random() < NEAR_MISS_SAMPLE_RATE) {
          const reason = nearMissReason(text, isReply)
          if (reason) {
            console.log(
              JSON.stringify({ nearMiss: true, reason, uri, text: text.slice(0, 200) }),
            )
          }
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
