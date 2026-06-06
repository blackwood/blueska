// Usage: ts-node scripts/inspectPost.ts <bsky.app post URL>
// Resolves a Bluesky post URL to its AT-proto URI, fetches the text,
// and runs it through the gate and lexicon scorer for labeling/debugging.

import { computeLexiconScore } from '../src/util/lexiconScore'

const API = 'https://public.api.bsky.app/xrpc'

async function resolveHandle(handle: string): Promise<string> {
  const res = await fetch(
    `${API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
  )
  if (!res.ok) throw new Error(`Could not resolve handle: ${handle}`)
  const { did } = (await res.json()) as { did: string }
  return did
}

async function getPostText(did: string, rkey: string): Promise<string> {
  const uri = `at://${did}/app.bsky.feed.post/${rkey}`
  const res = await fetch(
    `${API}/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=app.bsky.feed.post&rkey=${encodeURIComponent(rkey)}`,
  )
  if (!res.ok) throw new Error(`Could not fetch post ${uri}`)
  const data = (await res.json()) as { value?: { text?: string } }
  return data.value?.text ?? ''
}

async function main() {
  const url = process.argv[2]
  if (!url) {
    console.error('Usage: ts-node scripts/inspectPost.ts <bsky.app post URL>')
    process.exit(1)
  }

  // Parse https://bsky.app/profile/<handle>/post/<rkey>
  const match = url.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/)
  if (!match) {
    console.error('Could not parse URL — expected https://bsky.app/profile/<handle>/post/<rkey>')
    process.exit(1)
  }
  const [, handle, rkey] = match

  const did = await resolveHandle(handle)
  const atUri = `at://${did}/app.bsky.feed.post/${rkey}`
  const text = await getPostText(did, rkey)
  const lexicon = computeLexiconScore(text)

  console.log('\nAT-URI (for examples.json):')
  console.log(' ', atUri)
  console.log('\nText:')
  console.log(' ', text)
  console.log('\nLexicon score:', lexicon.toFixed(4))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
