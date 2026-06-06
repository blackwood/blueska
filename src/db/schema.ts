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
  updatedAt: string
}
