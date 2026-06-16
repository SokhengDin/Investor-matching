import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppConfig } from "../../config.js"

export interface SourceResult {
  url:   string
  title: string
  type:  string
}

const LinkupResultItem = Schema.Struct({
  url:     Schema.String,
  name:    Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  type:    Schema.optional(Schema.String)
})

const LinkupResponse = Schema.Struct({
  results: Schema.Array(LinkupResultItem)
})

const ExaResultItem = Schema.Struct({
  url:   Schema.String,
  title: Schema.optional(Schema.String)
})

const ExaResponse = Schema.Struct({
  results: Schema.Array(ExaResultItem)
})

export class InvestorSources extends Context.Service<InvestorSources, {
  searchLinkup(query: string):         Effect.Effect<ReadonlyArray<SourceResult>>
  searchExa(query: string):            Effect.Effect<ReadonlyArray<SourceResult>>
  searchInvestorSources(name: string): Effect.Effect<ReadonlyArray<SourceResult>>
}>()("agentic-matching/investor/InvestorSources") {
  static readonly layer = Layer.effect(
    InvestorSources,
    Effect.gen(function*() {
      const httpClient                  = yield* HttpClient.HttpClient
      const { linkupApiKey, exaApiKey } = yield* AppConfig

      const searchLinkup = Effect.fn("InvestorSources.searchLinkup")(function*(query: string) {
        return yield* HttpClientRequest.post("https://api.linkup.so/v1/search").pipe(
          HttpClientRequest.bearerToken(Redacted.value(linkupApiKey)),
          HttpClientRequest.bodyJsonUnsafe({ q: query, depth: "standard", outputType: "searchResults" }),
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(LinkupResponse)),
          Effect.map((r) =>
            r.results.map((item): SourceResult => ({
              url:   item.url,
              title: item.name ?? item.url,
              type:  item.type ?? "web"
            }))
          ),
          Effect.orDie
        )
      })

      const searchExa = Effect.fn("InvestorSources.searchExa")(function*(query: string) {
        return yield* HttpClientRequest.post("https://api.exa.ai/search").pipe(
          HttpClientRequest.setHeader("x-api-key", Redacted.value(exaApiKey)),
          HttpClientRequest.bodyJsonUnsafe({ query, numResults: 10, useAutoprompt: true, type: "neural" }),
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ExaResponse)),
          Effect.map((r) =>
            r.results.map((item): SourceResult => ({
              url:   item.url,
              title: item.title ?? item.url,
              type:  "web"
            }))
          ),
          Effect.orDie
        )
      })

      const searchInvestorSources = Effect.fn("InvestorSources.searchInvestorSources")(function*(name: string) {
        const query   = `${name} investor podcast interview site:youtube.com OR site:youtu.be OR site:podcasts.apple.com OR site:open.spotify.com`
        const linkup  = yield* searchLinkup(query)
        const results = linkup.length > 0
          ? linkup
          : yield* searchExa(query)
        const seen    = new Set<string>()
        const deduped: SourceResult[] = []
        for (const item of results) {
          if (!seen.has(item.url)) {
            seen.add(item.url)
            deduped.push(item)
          }
        }
        return deduped
      })

      return InvestorSources.of({ searchLinkup, searchExa, searchInvestorSources })
    })
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(AppConfig.layer)
  )
}
