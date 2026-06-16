import "dotenv/config"
import { Effect, Layer } from "effect"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { layerUndici } from "@effect/platform-node/NodeHttpClient"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import { Api } from "./api.js"
import { InvestorHandlers } from "./domains/investor/investor.http.js"

const SystemHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function*(handlers) {
    return handlers.handle("health", () => Effect.void)
  })
)

const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([InvestorHandlers, SystemHandlers])
)

const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" })

const AllRoutes = Layer.mergeAll(ApiRoutes, DocsRoute)

const HttpServerLayer = HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
  Layer.provide(layerUndici)
)

NodeRuntime.runMain(Layer.launch(HttpServerLayer))
