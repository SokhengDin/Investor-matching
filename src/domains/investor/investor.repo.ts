import { Context, Effect, Layer } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { Core } from "../../core.js"
import { Investor, InvestorError, InvestorId, InvestorNotFound, Persona } from "./investor.types.js"

export class InvestorRepo extends Context.Service<InvestorRepo, {
  insert(opts: {
    name:       string
    sourceUrl:  string
    transcript: string
    persona:    Persona
    embedding:  ReadonlyArray<number>
  }): Effect.Effect<Investor, SqlError>

  findById(id: InvestorId): Effect.Effect<Investor, InvestorError | SqlError>

  listAll():   Effect.Effect<ReadonlyArray<Investor>, SqlError>

  similarTo(
    embedding: ReadonlyArray<number>,
    limit:     number
  ): Effect.Effect<ReadonlyArray<{ id: string; name: string; similarity: number; sectors: ReadonlyArray<string> }>, SqlError>
}>()("agentic-matching/investor/InvestorRepo") {
  static readonly layer = Layer.effect(
    InvestorRepo,
    Effect.gen(function*() {
      const { sql, pg } = yield* Core

      const insert = Effect.fn("InvestorRepo.insert")(function*(opts: {
        name:       string
        sourceUrl:  string
        transcript: string
        persona:    Persona
        embedding:  ReadonlyArray<number>
      }) {
        const vec = `[${opts.embedding.join(",")}]`
        const rows = yield* sql<{ id: string; created_at: string }>`
          INSERT INTO investor_profile (name, source_url, transcript, persona, embedding)
          VALUES (
            ${opts.name},
            ${opts.sourceUrl},
            ${opts.transcript},
            ${pg.json(opts.persona)},
            ${vec}::vector
          )
          RETURNING id, created_at
        `
        const row = rows[0]
        return new Investor({
          id: InvestorId.make(row.id),
          name: opts.name,
          sourceUrl: opts.sourceUrl,
          persona: opts.persona,
          createdAt: String(row.created_at)
        })
      })

      const findById = Effect.fn("InvestorRepo.findById")(function*(id: InvestorId) {
        const rows = yield* sql<{
          id: string
          name: string
          source_url: string
          persona: unknown
          created_at: string
        }>`
          SELECT id, name, source_url, persona, created_at
          FROM investor_profile
          WHERE id = ${id}
        `
        if (rows.length === 0) {
          return yield* new InvestorError({ reason: new InvestorNotFound({ id }) })
        }
        const r = rows[0]
        return new Investor({
          id: InvestorId.make(r.id),
          name: r.name,
          sourceUrl: r.source_url,
          persona: r.persona as Persona,
          createdAt: String(r.created_at)
        })
      })

      const listAll = Effect.fn("InvestorRepo.listAll")(function*() {
        const rows = yield* sql<{
          id: string
          name: string
          source_url: string
          persona: unknown
          created_at: string
        }>`
          SELECT id, name, source_url, persona, created_at
          FROM investor_profile
          ORDER BY created_at DESC
        `
        return rows.map((r) =>
          new Investor({
            id: InvestorId.make(r.id),
            name: r.name,
            sourceUrl: r.source_url,
            persona: r.persona as Persona,
            createdAt: String(r.created_at)
          })
        )
      })

      const similarTo = Effect.fn("InvestorRepo.similarTo")(function*(
        embedding: ReadonlyArray<number>,
        limit: number
      ) {
        const vec = `[${embedding.join(",")}]`
        const rows = yield* sql<{ id: string; name: string; similarity: string; sectors: unknown }>`
          SELECT id, name,
                 1 - (embedding <=> ${vec}::vector) AS similarity,
                 persona->'sectors' AS sectors
          FROM investor_profile
          WHERE embedding IS NOT NULL
          ORDER BY embedding <=> ${vec}::vector
          LIMIT ${limit}
        `
        return rows.map((r) => ({
          id:         r.id,
          name:       r.name,
          similarity: parseFloat(r.similarity),
          sectors:    Array.isArray(r.sectors) ? (r.sectors as string[]) : []
        }))
      })

      return InvestorRepo.of({ insert, findById, listAll, similarTo })
    })
  ).pipe(Layer.provide(Core.layer))
}
