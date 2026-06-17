import * as fs            from "node:fs"
import * as path          from "node:path"
import * as https         from "node:https"
import { fileURLToPath }  from "node:url"
import { spawn }          from "node:child_process"
import { Config, Context, Effect, Layer, Redacted } from "effect"
import { NodeServices }   from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { LanguageModel }  from "effect/unstable/ai/LanguageModel"
import { EmbeddingModel } from "effect/unstable/ai/EmbeddingModel"
import { layerConfig as openAiLayerConfig } from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel  from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as OpenAiEmbeddingModel from "@effect/ai-openai-compat/OpenAiEmbeddingModel"
import { AppConfig }        from "../../config.js"
import { InvestorRepo }    from "./investor.repo.js"
import { InvestorSources, type SourceResult } from "./investor.sources.js"
import { Investor, InvestorError, InvestorId, MatchResult, PipelineError, Persona, Sentiment, FounderProfile } from "./investor.types.js"

const MISTRAL_API_URL = "https://api.mistral.ai/v1"

const PROJECT_ROOT        = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../")
const AUDIO_DIR           = path.join(PROJECT_ROOT, "audio")
const TRANSCRIPTIONS_DIR  = path.join(PROJECT_ROOT, "transcriptions")
const YTDLP_BIN           = path.join(PROJECT_ROOT, ".venv/bin/yt-dlp")
const EXTRACT_PERSONA_MD   = path.join(PROJECT_ROOT, "src/prompts/extract-persona.md")
const SENTIMENT_ANALYSIS_MD = path.join(PROJECT_ROOT, "src/prompts/sentiment-analysis.md")

const extractPersonaTemplate   = fs.readFileSync(EXTRACT_PERSONA_MD, "utf8")
const sentimentAnalysisTemplate = fs.readFileSync(SENTIMENT_ANALYSIS_MD, "utf8")

const VIDEO_URL_RE  = /youtube\.com|youtu\.be|vimeo\.com|podcasts\.apple\.com|open\.spotify\.com|anchor\.fm|buzzsprout\.com|simplecast\.com|transistor\.fm/i
const ARTICLE_URL_RE = /wikipedia\.org|linkedin\.com|twitter\.com|x\.com|crunchbase\.com|techcrunch\.com|forbes\.com|bloomberg\.com|nytimes\.com|wsj\.com|medium\.com/i

function transcribeAudio(audioPath: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const boundary = `----FormBoundary${Date.now().toString(16)}`
    const audioData = fs.readFileSync(audioPath)
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nvoxtral-mini-2507\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`
    )
    const footer  = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body    = Buffer.concat([header, audioData, footer])

    const req = https.request({
      hostname: "api.mistral.ai",
      path:     "/v1/audio/transcriptions",
      method:   "POST",
      headers: {
        "Authorization":  `Bearer ${apiKey}`,
        "Content-Type":   `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length
      }
    }, (res) => {
      let data = ""
      res.on("data", (chunk: Buffer) => { data += chunk.toString() })
      res.on("end", () => {
        try {
          const json = JSON.parse(data) as { text?: string; message?: string; object?: string }
          if (json.text !== undefined) resolve(json.text)
          else reject(new Error(`Voxtral error (HTTP ${res.statusCode}): ${data}`))
        } catch (e) { reject(e) }
      })
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

function cleanTranscript(raw: string): string {
  return raw
    .replace(/\b(um|uh|like|you know)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

function ytDlp(url: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, [
      "-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", outPath, url
    ])
    let stderr = ""
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`yt-dlp exited ${code}: ${stderr}`))
    })
  })
}

function pickBestUrl(results: ReadonlyArray<SourceResult>): string | undefined {
  const audioVideo = results.find((r) => VIDEO_URL_RE.test(r.url))
  if (audioVideo) return audioVideo.url
  const nonArticle = results.find((r) => !ARTICLE_URL_RE.test(r.url))
  return nonArticle?.url
}

export class InvestorService extends Context.Service<InvestorService, {
  ingestByName(opts: { name: string }):       Effect.Effect<Investor, PipelineError>
  ingestFromUrl(opts: {
    name: string
    url:  string
  }):                                         Effect.Effect<Investor>
  getById(id: InvestorId):                    Effect.Effect<Investor, InvestorError>
  listAll():                                  Effect.Effect<ReadonlyArray<Investor>>
  matchFounder(profile: FounderProfile):      Effect.Effect<ReadonlyArray<MatchResult>>
  searchSources(name: string):                Effect.Effect<ReadonlyArray<SourceResult>>
}>()("agentic-matching/investor/InvestorService") {
  static readonly layer = Layer.effect(
    InvestorService,
    Effect.gen(function*() {
      const repo       = yield* InvestorRepo
      const sources    = yield* InvestorSources
      const { mistralApiKey } = yield* AppConfig
      const llm        = yield* LanguageModel
      const embedModel = yield* EmbeddingModel

      const extractAudio = Effect.fn("InvestorService.extractAudio")(function*(url: string) {
        fs.mkdirSync(AUDIO_DIR, { recursive: true })
        const outPath = path.join(AUDIO_DIR, `investor-${Date.now()}.mp3`)
        yield* Effect.tryPromise({
          try:   () => ytDlp(url, outPath),
          catch: (e) => e as Error
        }).pipe(
          Effect.timeout("90 seconds"),
          Effect.orDie
        )
        return outPath
      })

      const transcribe = Effect.fn("InvestorService.transcribe")(function*(audioPath: string) {
        const raw    = yield* Effect.tryPromise({
          try:   () => transcribeAudio(audioPath, Redacted.value(mistralApiKey)),
          catch: (e) => e as Error
        }).pipe(Effect.orDie)
        const cleaned   = cleanTranscript(raw)
        const outPath   = path.join(TRANSCRIPTIONS_DIR, `${path.basename(audioPath, ".mp3")}.txt`)
        const wrapped   = cleaned.replace(/(.{120})\s/g, "$1\n")
        yield* Effect.try({
          try:   () => { fs.mkdirSync(TRANSCRIPTIONS_DIR, { recursive: true }); fs.writeFileSync(outPath, wrapped, "utf8") },
          catch: (e) => e as Error
        }).pipe(Effect.orDie)
        return cleaned
      })

      const analyzeSentiment = Effect.fn("InvestorService.analyzeSentiment")(function*(text: string) {
        const prompt   = sentimentAnalysisTemplate.replace("{{text}}", text)
        const response = yield* llm.generateText({ prompt }).pipe(Effect.orDie)
        const raw      = response.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
        return yield* Effect.try({
          try:   () => new Sentiment(JSON.parse(raw) as Sentiment),
          catch: (e) => new Error(`Sentiment parse failed: ${e}`)
        }).pipe(Effect.orDie)
      })

      const extractPersona = Effect.fn("InvestorService.extractPersona")(function*(transcript: string) {
        const [sentiment, personaResponse] = yield* Effect.all(
          [
            analyzeSentiment(transcript),
            llm.generateText({ prompt: extractPersonaTemplate.replace("{{transcript}}", transcript) }).pipe(Effect.orDie)
          ],
          { concurrency: "unbounded" }
        )
        const raw  = personaResponse.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
        const base = yield* Effect.try({
          try:   () => JSON.parse(raw) as { thesis: string; style: string; sectors: string[]; aversion: string[]; tone: string },
          catch: (e) => new Error(`Persona parse failed: ${e}`)
        }).pipe(Effect.orDie)
        return new Persona({
          thesis:    base.thesis,
          style:     base.style,
          sectors:   base.sectors,
          aversion:  base.aversion,
          tone:      base.tone,
          sentiment
        })
      })

      const runPipeline = Effect.fn("InvestorService.runPipeline")(function*(opts: {
        name:      string
        sourceUrl: string
      }) {
        const audioPath   = yield* extractAudio(opts.sourceUrl)
        const transcript  = yield* transcribe(audioPath)
        const persona     = yield* extractPersona(transcript).pipe(Effect.orDie)
        const personaText = `${persona.thesis} ${persona.sectors.join(" ")} ${persona.style}`
        const { vector }  = yield* embedModel.embed(personaText).pipe(Effect.orDie)
        return yield* repo.insert({
          name:      opts.name,
          sourceUrl: opts.sourceUrl,
          transcript,
          persona,
          embedding: vector
        }).pipe(Effect.orDie)
      })

      const ingestByName = Effect.fn("InvestorService.ingestByName")(function*(opts: { name: string }) {
        const results = yield* sources.searchInvestorSources(opts.name)
        const url     = pickBestUrl(results)
        if (url === undefined) {
          return yield* Effect.fail(new PipelineError({
            message: `No audio/video source found for investor "${opts.name}"`
          }))
        }
        return yield* runPipeline({ name: opts.name, sourceUrl: url })
      })

      const ingestFromUrl = Effect.fn("InvestorService.ingestFromUrl")(function*(opts: {
        name: string
        url:  string
      }) {
        return yield* runPipeline({ name: opts.name, sourceUrl: opts.url })
      })

      const matchFounder = Effect.fn("InvestorService.matchFounder")(function*(profile: FounderProfile) {
        const embedText              = `${profile.companyName} ${profile.stage} ${profile.sectors.join(" ")} ${profile.pitch}`
        const { vector: founderVec } = yield* embedModel.embed(embedText).pipe(Effect.orDie)
        const candidates             = yield* repo.similarTo(founderVec, profile.limit ?? 10).pipe(Effect.orDie)
        const founderSectors = profile.sectors.map((s) => s.toLowerCase().replace(/[-_]/g, " "))
        return candidates.map((c) => {
          const personaScore   = c.similarity
          const investorText   = c.sectors.join(" ").toLowerCase().replace(/[()[\],]/g, " ")
          const investorWords  = new Set(investorText.split(/\s+/).filter((w) => w.length > 2))
          const matched = founderSectors.filter((tag) =>
            investorText.includes(tag) ||
            tag.split(" ").filter((w) => w.length > 2).every((w) => investorWords.has(w))
          )
          const structuredScore = founderSectors.length > 0 ? matched.length / founderSectors.length : 0
          const finalScore      = 0.5 * structuredScore + 0.5 * personaScore
          return new MatchResult({
            investorId:      InvestorId.make(c.id),
            investorName:    c.name,
            structuredScore,
            personaScore,
            finalScore
          })
        })
      })

      return InvestorService.of({
        ingestByName,
        ingestFromUrl,
        getById:       (id)   => repo.findById(id).pipe(Effect.catchTag("SqlError", Effect.die)),
        listAll:       ()     => repo.listAll().pipe(Effect.orDie),
        matchFounder,
        searchSources: (name) => sources.searchInvestorSources(name)
      })
    })
  ).pipe(
    Layer.provide(InvestorRepo.layer),
    Layer.provide(InvestorSources.layer),
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function*() {
          const { mistralApiKey } = yield* AppConfig
          const clientLayer = openAiLayerConfig({
            apiKey: Config.succeed(mistralApiKey),
            apiUrl: Config.succeed(MISTRAL_API_URL)
          }).pipe(Layer.provide(FetchHttpClient.layer))
          return Layer.mergeAll(
            OpenAiLanguageModel.layer({ model: "mistral-large-latest" }).pipe(Layer.provide(clientLayer)),
            OpenAiEmbeddingModel.layer({ model: "mistral-embed" }).pipe(Layer.provide(clientLayer))
          )
        })
      )
    ),
    Layer.provide(AppConfig.layer),
    Layer.provide(NodeServices.layer)
  )
}
