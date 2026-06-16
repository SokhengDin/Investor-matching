import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InvestorService } from "./investor.js"
import { Api } from "../../api.js"

export const InvestorHandlers = HttpApiBuilder.group(
  Api,
  "investors",
  Effect.fn(function*(handlers) {
    const svc = yield* InvestorService

    return handlers
      .handle("list", () =>
        svc.listAll().pipe(Effect.orDie)
      )
      .handle("getById", ({ params }) =>
        svc.getById(params.id).pipe(
          Effect.catchTag("InvestorError", (e) =>
            e.reason._tag === "InvestorNotFound"
              ? Effect.fail(e.reason)
              : Effect.die(e)
          )
        )
      )
      .handle("ingest", ({ payload }) =>
        svc.ingestByName({ name: payload.name }).pipe(
          Effect.catchTag("PipelineError", Effect.fail)
        )
      )
      .handle("match", ({ payload }) =>
        svc.matchFounder(payload).pipe(Effect.orDie)
      )
  })
).pipe(Layer.provide(InvestorService.layer))
