export type DatabaseSchema = {
  post: Post
  sub_state: SubState
  like: Like
  author_score: AuthorScore
}

export type Post = {
  uri: string
  cid: string
  authorDid: string
  indexedAt: string
  likeCount: number
  lexiconScore: number
  scoreVersion: number
  inclusionReason: string // 'keyword' | 'full' | 'posts_only' | 'metered'
}

export type SubState = {
  service: string
  cursor: number
}

export type Like = {
  uri: string
  subjectUri: string
}

export type AuthorScore = {
  did: string
  score: number
  tier: string // 'full' | 'posts_only' | 'metered' | 'blocked'
  updatedAt: string
}
