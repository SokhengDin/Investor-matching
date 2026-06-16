import { Schema } from "effect"

export const InvestorId = Schema.String.pipe(Schema.brand("InvestorId"))
export type  InvestorId = typeof InvestorId.Type

export class Sentiment extends Schema.Class<Sentiment>("Sentiment")({
  overall:        Schema.Literals(["positive", "neutral", "negative", "mixed"]),
  confidence:     Schema.Literals(["high", "medium", "low"]),
  riskAppetite:   Schema.Literals(["aggressive", "moderate", "conservative"]),
  founderEmpathy: Schema.Literals(["high", "medium", "low"]),
  keySignals:     Schema.Array(Schema.String)
}) {}

export class Persona extends Schema.Class<Persona>("Persona")({
  thesis:    Schema.String,
  style:     Schema.String,
  sectors:   Schema.Array(Schema.String),
  aversion:  Schema.Array(Schema.String),
  tone:      Schema.String,
  sentiment: Sentiment
}) {}

export class Investor extends Schema.Class<Investor>("Investor")({
  id:        InvestorId,
  name:      Schema.String,
  sourceUrl: Schema.String,
  persona:   Persona,
  createdAt: Schema.String
}) {}

export class FounderProfile extends Schema.Class<FounderProfile>("FounderProfile")({
  companyName: Schema.String,
  stage:       Schema.Literals(["pre-seed", "seed", "series-a", "series-b", "growth"]),
  sectors:     Schema.Array(Schema.String),
  pitch:       Schema.String,
  limit:       Schema.optional(Schema.Int)
}) {}

export class MatchResult extends Schema.Class<MatchResult>("MatchResult")({
  investorId:      InvestorId,
  investorName:    Schema.String,
  structuredScore: Schema.Number,
  personaScore:    Schema.Number,
  finalScore:      Schema.Number
}) {}

export class InvestorNotFound extends Schema.TaggedErrorClass<InvestorNotFound>()(
  "InvestorNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 }
) {}

export class PipelineError extends Schema.TaggedErrorClass<PipelineError>()(
  "PipelineError",
  { message: Schema.String },
  { httpApiStatus: 422 }
) {}

export class InvestorError extends Schema.TaggedErrorClass<InvestorError>()(
  "InvestorError",
  { reason: Schema.Union([InvestorNotFound, PipelineError]) }
) {}
