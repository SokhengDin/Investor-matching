import { Context, Effect, Layer } from "effect"
import { PgClient, layer as pgLayer } from "@effect/sql-pg/PgClient"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { AppConfig } from "./config.js"

export class Core extends Context.Service<Core, {
  readonly sql: SqlClient
  readonly pg: PgClient
}>()("agentic-matching/Core") {
  static readonly layer = Layer.unwrap(
    Effect.gen(function*() {
      const { databaseUrl } = yield* AppConfig
      const pgLayer_ = pgLayer({ url: databaseUrl })

      return Layer.effect(
        Core,
        Effect.gen(function*() {
          const sql = yield* SqlClient
          const pg = yield* PgClient

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
          yield* Effect.logInfo("Core: schema ready")

          return Core.of({ sql, pg })
        })
      ).pipe(Layer.provide(pgLayer_))
    })
  ).pipe(Layer.provide(AppConfig.layer))
}
