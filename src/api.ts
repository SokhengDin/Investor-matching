import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvestorApiGroup } from "./domains/investor/investor.api.js"

class SystemGroup extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", {
    success: HttpApiSchema.NoContent
  })
) {}

export class Api extends HttpApi.make("agentic-matching-api")
  .add(SystemGroup)
  .add(InvestorApiGroup)
  .annotateMerge(OpenApi.annotations({ title: "Agentic Matching API" }))
{}
