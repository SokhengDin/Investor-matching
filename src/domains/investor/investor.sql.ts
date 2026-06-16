import { Config, Effect, Layer } from "effect"
import { layerConfig as pgLayerConfig } from "@effect/sql-pg/PgClient"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const PgLayer = pgLayerConfig({
  url: Config.redacted("DATABASE_URL")
})

export const MigrateLayer = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient
    yield* sql`CREATE EXTENSION IF NOT EXISTS vector`
    yield* sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`
    yield* sql`
      CREATE TABLE IF NOT EXISTS investor_profile (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL,
        source_url  text NOT NULL,
        transcript  text,
        persona     jsonb NOT NULL,
        embedding   vector(1024),
        created_at  timestamptz DEFAULT now()
      )
    `
    yield* sql`
      CREATE INDEX IF NOT EXISTS investor_embedding_hnsw_idx
        ON investor_profile
        USING hnsw (embedding vector_cosine_ops)
    `
    yield* Effect.logInfo("investor/sql: schema ready")
  })
).pipe(Layer.provide(PgLayer))
