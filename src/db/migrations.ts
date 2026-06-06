import { Kysely, Migration, MigrationProvider, sql } from 'kysely'

const migrations: Record<string, Migration> = {}

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}

migrations['001'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('post')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('cid', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createTable('sub_state')
      .addColumn('service', 'varchar', (col) => col.primaryKey())
      .addColumn('cursor', 'integer', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('post').execute()
    await db.schema.dropTable('sub_state').execute()
  },
}

migrations['002'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .alterTable('post')
      .addColumn('likeCount', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable('post').dropColumn('likeCount').execute()
  },
}

migrations['003'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('like')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('subjectUri', 'varchar', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('like').execute()
  },
}

migrations['004'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('author_score')
      .addColumn('did', 'varchar', (col) => col.primaryKey())
      .addColumn('score', 'real', (col) => col.notNull().defaultTo(0))
      .addColumn('updatedAt', 'varchar', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('author_score').execute()
  },
}

migrations['005'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .alterTable('post')
      .addColumn('authorDid', 'varchar', (col) => col.notNull().defaultTo(''))
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable('post').dropColumn('authorDid').execute()
  },
}

migrations['006'] = {
  async up(db: Kysely<unknown>) {
    await sql`CREATE INDEX IF NOT EXISTS post_indexedAt_idx ON post (indexedAt DESC)`.execute(
      db,
    )
    await sql`CREATE INDEX IF NOT EXISTS post_like_idx ON post (likeCount DESC, indexedAt DESC)`.execute(
      db,
    )
  },
  async down(db: Kysely<unknown>) {
    await sql`DROP INDEX IF EXISTS post_indexedAt_idx`.execute(db)
    await sql`DROP INDEX IF EXISTS post_like_idx`.execute(db)
  },
}

migrations['007'] = {
  async up(db: Kysely<unknown>) {
    // Index on subjectUri so the hourly orphaned-like cleanup is a fast scan
    await sql`CREATE INDEX IF NOT EXISTS like_subjectUri_idx ON "like" (subjectUri)`.execute(
      db,
    )
  },
  async down(db: Kysely<unknown>) {
    await sql`DROP INDEX IF EXISTS like_subjectUri_idx`.execute(db)
  },
}

migrations['008'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .alterTable('post')
      .addColumn('lexiconScore', 'real', (col) => col.notNull().defaultTo(0))
      .execute()
    await db.schema
      .alterTable('post')
      .addColumn('scoreVersion', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable('post').dropColumn('lexiconScore').execute()
    await db.schema.alterTable('post').dropColumn('scoreVersion').execute()
  },
}
