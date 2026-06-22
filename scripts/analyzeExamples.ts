// Usage: yarn analyzeExamples
//
// For each URI in data/examples.json:
//   - fetches post text via Bluesky public API
//   - runs it through isSkaRelated() (the firehose gate) and computeLexiconScore()
//   - prints per-category score distributions and misclassifications
//
// Goal: verify the gate and lexicon vocabulary actually separate positive
// categories (gig, listener, promo) from negative ones before tuning weights
// or K in lexiconScore.ts.
//
// The same labeled set becomes training data when swapping to centroid
// embeddings — both use the same score(text):number interface.

import fs from 'fs'
import path from 'path'
import { computeLexiconScore } from '../src/util/lexiconScore'
import { isSkaRelated } from '../src/subscription'

const API = 'https://public.api.bsky.app/xrpc'
const EXAMPLES_PATH = path.join(__dirname, '../data/examples.json')

type ExamplesFile = {
  version: number
  positive: Record<string, string[]>
  negative: Record<string, string[]>
}

type Example = {
  uri: string
  sentiment: 'positive' | 'negative'
  category: string
  text?: string
  lexiconScore?: number
  gatePass?: boolean
}

async function fetchTexts(uris: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < uris.length; i += 25) {
    const batch = uris.slice(i, i + 25)
    const qs = batch.map((u) => `uris=${encodeURIComponent(u)}`).join('&')
    try {
      const res = await fetch(`${API}/app.bsky.feed.getPosts?${qs}`)
      if (!res.ok) {
        console.warn(`  ! API ${res.status} for batch at index ${i}`)
        continue
      }
      const data = (await res.json()) as {
        posts: Array<{ uri: string; record?: { text?: string } }>
      }
      for (const p of data.posts) {
        out.set(p.uri, p.record?.text ?? '')
      }
    } catch (err) {
      console.warn(`  ! Fetch error at batch ${i}:`, err)
    }
  }
  return out
}

function avg(vals: number[]): number {
  return vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0
  const s = [...vals].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

function bar(score: number, width = 20): string {
  const filled = Math.round(score * width)
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']'
}

async function main() {
  const raw = fs.readFileSync(EXAMPLES_PATH, 'utf8')
  const file: ExamplesFile = JSON.parse(raw)

  const examples: Example[] = []
  for (const [cat, uris] of Object.entries(file.positive)) {
    for (const uri of uris) examples.push({ uri, sentiment: 'positive', category: cat })
  }
  for (const [cat, uris] of Object.entries(file.negative)) {
    for (const uri of uris) examples.push({ uri, sentiment: 'negative', category: cat })
  }

  if (examples.length === 0) {
    console.log('No examples yet — add URIs to data/examples.json using yarn inspectPost.')
    process.exit(0)
  }

  process.stdout.write(`Fetching ${examples.length} posts... `)
  const textMap = await fetchTexts(examples.map((e) => e.uri))
  console.log('done\n')

  for (const ex of examples) {
    const text = textMap.get(ex.uri)
    if (text === undefined) continue
    ex.text = text
    ex.lexiconScore = computeLexiconScore(text)
    ex.gatePass = isSkaRelated(text)
  }

  const falseNegatives: Example[] = []
  const falsePositives: Example[] = []

  for (const sentiment of ['positive', 'negative'] as const) {
    const label = sentiment === 'positive' ? '✓ POSITIVE' : '✗ NEGATIVE'
    const categories =
      sentiment === 'positive'
        ? Object.keys(file.positive)
        : Object.keys(file.negative)

    console.log('═'.repeat(64))
    console.log(`  ${label}`)
    console.log('═'.repeat(64))

    for (const cat of categories) {
      const group = examples.filter(
        (e) => e.sentiment === sentiment && e.category === cat && e.text !== undefined,
      )
      if (group.length === 0) {
        console.log(`\n  [${cat}] — no examples yet`)
        continue
      }

      const scores = group.map((e) => e.lexiconScore!)
      const passing = group.filter((e) => e.gatePass).length
      console.log(
        `\n  [${cat}]  n=${group.length}  ` +
          `avg=${avg(scores).toFixed(3)}  median=${median(scores).toFixed(3)}  ` +
          `gate=${passing}/${group.length}`,
      )

      for (const ex of group) {
        const gateTag = ex.gatePass ? 'PASS' : 'FAIL'
        const isMismatch =
          (sentiment === 'positive' && !ex.gatePass) ||
          (sentiment === 'negative' && ex.gatePass)
        const flag = isMismatch ? '  ⚠ MISMATCH' : ''
        const text = (ex.text ?? '').slice(0, 90).replace(/\n/g, ' ')
        console.log(
          `    ${bar(ex.lexiconScore!)} ${ex.lexiconScore!.toFixed(3)}  [${gateTag}]${flag}`,
        )
        console.log(`      "${text}"`)

        if (sentiment === 'positive' && !ex.gatePass) falseNegatives.push(ex)
        if (sentiment === 'negative' && ex.gatePass) falsePositives.push(ex)
      }
    }
    console.log()
  }

  // Overall summary
  const pos = examples.filter((e) => e.sentiment === 'positive' && e.lexiconScore !== undefined)
  const neg = examples.filter((e) => e.sentiment === 'negative' && e.lexiconScore !== undefined)
  const posScores = pos.map((e) => e.lexiconScore!)
  const negScores = neg.map((e) => e.lexiconScore!)

  console.log('═'.repeat(64))
  console.log('  SUMMARY')
  console.log('═'.repeat(64))
  console.log(
    `\n  Positives  n=${pos.length}  avg=${avg(posScores).toFixed(3)}` +
      `  gate=${pos.filter((e) => e.gatePass).length}/${pos.length} pass`,
  )
  console.log(
    `  Negatives  n=${neg.length}  avg=${avg(negScores).toFixed(3)}` +
      `  gate=${neg.filter((e) => e.gatePass).length}/${neg.length} pass`,
  )

  if (posScores.length > 0 && negScores.length > 0) {
    const sep = avg(posScores) - avg(negScores)
    console.log(
      `  Separation: ${sep >= 0 ? '+' : ''}${sep.toFixed(3)}  (positive avg − negative avg)`,
    )
    if (Math.abs(sep) < 0.1)
      console.log('  ⚠ Low separation — lexicon may not be discriminating yet')
  }

  if (falseNegatives.length > 0) {
    console.log(`\n  ⚠ FALSE NEGATIVES (ska posts that fail the gate) — ${falseNegatives.length}:`)
    for (const ex of falseNegatives) {
      console.log(`    [${ex.category}] score=${ex.lexiconScore!.toFixed(3)}`)
      console.log(`      "${(ex.text ?? '').slice(0, 100).replace(/\n/g, ' ')}"`)
      console.log(`      ${ex.uri}`)
    }
  }

  if (falsePositives.length > 0) {
    console.log(`\n  ⚠ FALSE POSITIVES (non-ska posts that pass the gate) — ${falsePositives.length}:`)
    for (const ex of falsePositives) {
      console.log(`    [${ex.category}] score=${ex.lexiconScore!.toFixed(3)}`)
      console.log(`      "${(ex.text ?? '').slice(0, 100).replace(/\n/g, ' ')}"`)
      console.log(`      ${ex.uri}`)
    }
  }

  if (falseNegatives.length === 0 && falsePositives.length === 0 && examples.length > 0) {
    console.log('\n  ✓ No misclassifications in this example set.')
  }

  const missing = examples.filter((e) => e.text === undefined)
  if (missing.length > 0) {
    console.log(`\n  ! ${missing.length} post(s) unavailable (deleted or private):`)
    for (const ex of missing) console.log(`    [${ex.category}] ${ex.uri}`)
  }

  console.log()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
