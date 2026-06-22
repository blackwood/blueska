// Lexicon-based relevance scorer for ska posts.
//
// This is a precision re-ranker, not a recall tool: it reorders posts that
// already passed the isSkaRelated() gate in subscription.ts, rewarding posts
// that are more clearly ska-core. It cannot catch vocab-free posts from known
// scene accounts — that requires embeddings (same score(text):number interface,
// swap implementation when ready).
//
// Weights are derived from the gate's existing tiers (subscription.ts):
//   Tier 1 → HIGH_CONFIDENCE_PATTERNS: weights 0.8–1.0
//   Tier 2 → AMBIGUOUS_BAND_PATTERNS:  weights 0.4–0.6
//   Tier 3 → genre-adjacent signals:   weights 0.15–0.3
//
// Curve: 1 - exp(-sum / K) — never saturates, always spread.
// K=1.5 means one weight-1.0 term → 0.49; two → 0.74; four → 0.93.
// Bump K to widen the distribution if posts cluster too high.
//
// scoreVersion exported here — increment when vocabulary changes so callers
// can identify and recompute stale scores.

export const LEXICON_SCORE_VERSION = 3

const K = 1.5

// Tier 1: mirrors HIGH_CONFIDENCE_PATTERNS in subscription.ts
const TIER1: [RegExp, number][] = [
  [/\bska[-\s]?punk\b/i, 0.9],
  [/\bska[-\s]?core\b/i, 0.9],
  [
    /\bska[-\s]?(show|gig|concert|festival|tour|night|party|dance|bash|throwdown|cover|version|remix|arrangement)\b/i,
    0.9,
  ],
  [/\bthird[-\s]?wave\s+ska\b/i, 0.9],
  [/\bskankin[g']?\b/i, 1.0],
  [/\brudeboy\b/i, 0.9],
  [/\brudegirl\b/i, 0.9],
  [/\b(2|two)[-\s]?tone\s+ska\b/i, 0.9],
  [/#ska\b/i, 0.95],
  [/#blueska\b/i, 0.95],
  [/\b(the\s+)?skatalites\b/i, 0.9],
  [/\boperation\s+ivy\b/i, 0.85],
  [/\bless\s+than\s+jake\b/i, 0.85],
  [/\bstreetlight\s+manifesto\b/i, 0.85],
  [/\breel\s+big\s+fish\b/i, 0.85],
  [/\bmighty\s+mighty\s+bosstones\b/i, 0.85],
  [/\btoots\s+(and|&)\s+(the\s+)?maytals\b/i, 0.9],
  [/\bdesmond\s+dekker\b/i, 0.9],
]

// Tier 2: mirrors AMBIGUOUS_BAND_PATTERNS in subscription.ts
const TIER2: [RegExp, number][] = [
  [/\bthe\s+specials\b/i, 0.55],
  [/\b(the\s+)?selecter\b/i, 0.55],
  [/\bMadness\b/, 0.45], // case-sensitive, mirrors subscription.ts
  [/\bsave\s+ferris\b/i, 0.5],
  [/\bgoldfinger\b/i, 0.45],
  [/\bBad\s+Manners\b/, 0.45], // case-sensitive, mirrors subscription.ts
  [/\brock-?steady\b/i, 0.5], // moved from TIER1: now context-gated at subscription level
]

// Tier 3: genre-adjacent and instrumental signals
const TIER3: [RegExp, number][] = [
  [/\bupstroke\b/i, 0.3],
  [/\boffbeat\b/i, 0.25],
  [/\b(2|two)[-\s]?tone\b/i, 0.25],
  [/\brude[-\s]?(boy|girl)\b/i, 0.25],
  [/\breggae\b/i, 0.2],
  [/\bdancehall\b/i, 0.15],
  [/\bvinyl\b/i, 0.15],
  [/\bhorns?\b/i, 0.15],
  [/\btrumpet\b/i, 0.15],
  [/\btrombone\b/i, 0.2],
  [/\bsaxophone\b/i, 0.15],
  [/\bska\s+scene\b/i, 0.25],
  [/\bcheckerboard\b/i, 0.2],
]

const ALL_TERMS = [...TIER1, ...TIER2, ...TIER3]

export function computeLexiconScore(text: string): number {
  let sum = 0
  for (const [pattern, weight] of ALL_TERMS) {
    if (pattern.test(text)) sum += weight
  }
  return 1 - Math.exp(-sum / K)
}
