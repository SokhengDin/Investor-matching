import { Config, Context, Effect, Layer, Redacted } from "effect"

export class AppConfig extends Context.Service<AppConfig, {
  readonly databaseUrl:   Redacted.Redacted
  readonly mistralApiKey: Redacted.Redacted
  readonly linkupApiKey:  Redacted.Redacted
  readonly exaApiKey:     Redacted.Redacted
  readonly port:          number
}>()("agentic-matching/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const databaseUrl   = yield* Config.redacted("DATABASE_URL")
      const mistralApiKey = yield* Config.redacted("MISTRAL_API_KEY")
      const linkupApiKey  = yield* Config.redacted("LINKUP_API_KEY")
      const exaApiKey     = yield* Config.redacted("EXA_API_KEY")
      const port          = yield* Config.number("PORT").pipe(
        Effect.orElseSucceed(() => 3000)
      )
      return AppConfig.of({ databaseUrl, mistralApiKey, linkupApiKey, exaApiKey, port })
    })
  )
}
