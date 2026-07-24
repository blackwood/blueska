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

export const LEXICON_SCORE_VERSION = 4

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
  // Original ska (late 1950s–60s)
  [/\bLaurel\s+Aitken\b/i, 0.85],
  [/\bRoland\s+Alphonso\b/i, 0.85],
  [/\bTheophilus\s+Beckford\b/i, 0.85],
  [/\bVal\s+Bennett\b/i, 0.85],
  [/\bKen\s+Boothe\b/i, 0.85],
  [/\bBaba\s+Brooks\b/i, 0.85],
  [/\bPrince\s+Buster\b/i, 0.85],
  [/\b(the\s+)?Clarendonians\b/i, 0.85],
  [/\bJimmy\s+Cliff\b/i, 0.85],
  [/\bStranger\s+Cole\b/i, 0.85],
  [/\bDerrick\s+Harriott\b/i, 0.85],
  [/\bJustin\s+Hinds\b/i, 0.85],
  [/\bJah\s+Jerry\b/i, 0.85],
  [/\bLloyd\s+Knibb\b/i, 0.85],
  [/\bByron\s+Lee\b/i, 0.85],
  [/\bCount\s+Machuki\b/i, 0.85],
  [/\bCarlos\s+Malcolm\b/i, 0.85],
  [/\bTommy\s+McCook\b/i, 0.85],
  [/\b(the\s+)?Melodians\b/i, 0.85],
  [/\bDerrick\s+Morgan\b/i, 0.85],
  [/\bJackie\s+Opel\b/i, 0.85],
  [/\bScratch\s+Perry\b/i, 0.85],
  [/\bLord\s+Tanamo\b/i, 0.85],
  [/\bErnest\s+Ranglin\b/i, 0.85],
  [/\b(the\s+)?Silvertones\b/i, 0.85],
  [/\bMillie\s+Small\b/i, 0.85],
  [/\bSymarip\b/i, 0.85],
  [/\bLynn\s+Taitt\b/i, 0.85],
  [/\bAlton\s+Ellis\b/i, 0.85],
  [/\bDelroy\s+Wilson\b/i, 0.85],
  // 2-Tone revival (late 1970s–80s)
  [/\bAkrylykz\b/i, 0.85],
  [/\b(the\s+)?Apollinaires\b/i, 0.85],
  [/\bPauline\s+Black\b/i, 0.85],
  [/\bMike\s+Barson\b/i, 0.85],
  [/\bRhoda\s+Dakar\b/i, 0.85],
  [/\bJerry\s+Dammers\b/i, 0.85],
  [/\bLynval\s+Golding\b/i, 0.85],
  [/\bHorace\s+Panter\b/i, 0.85],
  [/\bRoddy\s+Radiation\b/i, 0.85],
  [/\bRanking\s+Roger\b/i, 0.85],
  [/\bChas\s+Smash\b/i, 0.85],
  [/\bNeville\s+Staple\b/i, 0.85],
  [/\bDave\s+Wakeling\b/i, 0.85],
  [/\bDaniel\s+Woodgate\b/i, 0.85],
  [/\bEverett\s+Morton\b/i, 0.85],
  // Third-wave ska (1980s–90s)
  [/\bAllniters\b/i, 0.85],
  [/\b(the\s+)?Aquabats\b/i, 0.85],
  [/\bArrogant\s+Sons\s+of\s+Bitches\b/i, 0.85],
  [/\bBig\s+D\s+and\s+the\s+Kids\s+Table\b/i, 0.85],
  [/\bBim\s+Skala\s+Bim\b/i, 0.85],
  [/\bBruce\s+Lee\s+Band\b/i, 0.85],
  [/\bBuck-O-Nine\b/i, 0.85],
  [/\bCherry\s+Poppin['']?\s*Daddies\b/i, 0.85],
  [/\b(the\s+)?Chinkees\b/i, 0.85],
  [/\bCitizen\s+Fish\b/i, 0.85],
  [/\bDance\s+Hall\s+Crashers\b/i, 0.85],
  [/\bDeal['']s\s+Gone\s+Bad\b/i, 0.85],
  [/\bEdna['']s\s+Goldfish\b/i, 0.85],
  [/\bFive\s+Iron\s+Frenzy\b/i, 0.85],
  [/\bFuzigish\b/i, 0.85],
  [/\b(the\s+)?Gadjits\b/i, 0.85],
  [/\bGOGO[-\s]?13\b/i, 0.85],
  [/\b(the\s+)?Hotknives\b/i, 0.85],
  [/\bInspecter\s+7\b/i, 0.85],
  [/\b(the\s+)?Insyderz\b/i, 0.85],
  [/\bKing\s+Apparatus\b/i, 0.85],
  [/\bFabulosos\s+Cadillacs\b/i, 0.85],
  [/\bMad\s+Caddies\b/i, 0.85],
  [/\bMark\s+Foggo\b/i, 0.85],
  [/\bSkasters\b/i, 0.85],
  [/\bMe\s+Mom\s+and\s+Morgentaler\b/i, 0.85],
  [/\bMephiskapheles\b/i, 0.85],
  [/\bMu[-\s]?330\b/i, 0.85],
  [/\bMustard\s+Plug\b/i, 0.85],
  [/\b(O\.C\.\s+)?Supertones\b/i, 0.85],
  [/\bPante[oó]n\s+Rococ[oó]\b/i, 0.85],
  [/\b(the\s+)?Planet\s+Smashers\b/i, 0.85],
  [/\bRough\s+Kutz\b/i, 0.85],
  [/\bRx\s+Bandits\b/i, 0.85],
  [/\b(the\s+)?Scofflaws\b/i, 0.85],
  [/\bSiren\s+Six\b/i, 0.85],
  [/\bSka-P\b/i, 0.85],
  [/\bSkavoovie\b/i, 0.85],
  [/\b(the\s+)?Skoidats\b/i, 0.85],
  [/\bSlow\s+Gherkin\b/i, 0.85],
  [/\bStubborn\s+All[-\s]Stars\b/i, 0.85],
  [/\bSuperhiks\b/i, 0.85],
  [/\bTokyo\s+Ska\s+Paradise\b/i, 0.85],
  [/\b(the\s+)?Uptones\b/i, 0.85],
  // Post-third wave (2000s–present)
  [/\bBandits\s+of\s+the\s+Acoustic\s+Revolution\b/i, 0.85],
  [/\bBeebs\s+and\s+Her\s+Money\s+Makers\b/i, 0.85],
  [/\bBomb\s+the\s+Music\s+Industry\b/i, 0.85],
  [/\b(the\s+)?Brass\s+Action\b/i, 0.85],
  [/\bCapdown\b/i, 0.85],
  [/\b(the\s+)?Cat\s+Empire\b/i, 0.85],
  [/\bChase\s+Long\s+Beach\b/i, 0.85],
  [/\bEn\s+Tol\s+Sarmiento\b/i, 0.85],
  [/\b(the\s+)?Flatliners\b/i, 0.85],
  [/\bGollbetty\b/i, 0.85],
  [/\bHowards\s+Alias\b/i, 0.85],
  [/\bHub\s+City\s+Stompers\b/i, 0.85],
  [/\bImperial\s+Leisure\b/i, 0.85],
  [/\b(the\s+)?Interrupters\b/i, 0.85],
  [/\bKing\s+Blues\b/i, 0.85],
  [/\bKingston\s+Rudieska\b/i, 0.85],
  [/\bLocomondo\b/i, 0.85],
  [/\bOreskaband\b/i, 0.85],
  [/\b(the\s+)?Orobians\b/i, 0.85],
  [/\bPannonia\s+Allstars\b/i, 0.85],
  [/\bRedSka\b/i, 0.85],
  [/\bSka\s+Cubano\b/i, 0.85],
  [/\b(the\s+)?Skints\b/i, 0.85],
  [/\bSlightly\s+Stoopid\b/i, 0.85],
  [/\bSonic\s+Boom\s+Six\b/i, 0.85],
  [/\b(the\s+)?Unlimiters\b/i, 0.85],
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
