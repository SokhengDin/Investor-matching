import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Investor, InvestorId, InvestorNotFound, MatchResult, PipelineError } from "./investor.types.js"

const IngestPayload = Schema.Struct({
  name: Schema.String
})

const FounderProfilePayload = Schema.Struct({
  companyName:  Schema.String,
  stage:        Schema.Literals(["pre-seed", "seed", "series-a", "series-b", "growth"]),
  sectors:      Schema.Array(Schema.String),
  pitch:        Schema.String,
  limit:        Schema.optional(Schema.Int)
})

const list = HttpApiEndpoint.get("list", "/", {
  success: Schema.Array(Investor)
})

const getById = HttpApiEndpoint.get("getById", "/:id", {
  params:  { id: Schema.String.pipe(Schema.decodeTo(InvestorId)) },
  success: Investor,
  error:   InvestorNotFound.pipe(
    HttpApiSchema.asNoContent({ decode: () => new InvestorNotFound({ id: "" }) })
  )
})

const ingest = HttpApiEndpoint.post("ingest", "/ingest", {
  payload: IngestPayload,
  success: Investor,
  error:   PipelineError.pipe(HttpApiSchema.status(422))
})

const match = HttpApiEndpoint.post("match", "/match", {
  payload: FounderProfilePayload,
  success: Schema.Array(MatchResult)
})

export class InvestorApiGroup extends HttpApiGroup.make("investors")
  .add(list)
  .add(getById)
  .add(ingest)
  .add(match)
  .prefix("/investors")
  .annotateMerge(OpenApi.annotations({ title: "Investors" }))
{}
