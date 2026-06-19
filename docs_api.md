# Agentic Matching — Design, Architecture & API Reference

## 1. Purpose

Agentic Matching is a system that turns an investor's **name** into a structured, embeddable persona — then uses that persona to match startup founders to the investors most likely to resonate with their pitch.

The core insight: instead of matching on structured metadata (sector tags, stage, check size), we extract the investor's *actual* voice from podcast interviews and use that as the semantic fingerprint. A founder's pitch is embedded in the same space and ranked by cosine distance.

---

## 2. Design Principles

### Effect-first
Every service, layer, and operation is modeled as an `Effect`. There are no raw `async/await` functions in application code. This gives us:
- Typed errors at every layer (`PipelineError`, `InvestorError`, `SqlError`)
- Composable dependency injection via `Context.Service` and `Layer`
- Automatic tracing and spans on every named operation

### Single source of truth per investor
The investor's **transcript** is the canonical artifact. Persona, sentiment, and embedding are all derived from it. If re-ingested, a new record is created rather than mutating the existing one — preserving history.

### Name-driven, not URL-driven
The public API takes only a name. Source discovery (which podcast, which episode) is handled internally by the search pipeline. Callers never need to supply or know about URLs.

### Separation of concerns
| Layer | Responsibility |
|---|---|
| `AppConfig` | Env vars, secrets |
| `Core` | DB connection, schema migrations |
| `InvestorRepo` | SQL read/write, pgvector queries |
| `InvestorSources` | External search (Linkup, Exa) |
| `InvestorService` | Orchestration — audio, AI, embedding |
| HTTP handlers | Request decoding, error mapping |

---

## 3. Technology Choices

| Concern | Choice | Why |
|---|---|---|
| Runtime framework | **Effect v4** | Typed errors, dependency injection, tracing, composable layers |
| Language model | **Mistral (`mistral-large-latest`)** | Strong instruction following, JSON output, OpenAI-compatible API |
| Transcription | **Mistral Voxtral (`voxtral-mini-2507`)** | Native audio → text, same API key as LLM |
| Embeddings | **Mistral (`mistral-embed`, 1024-dim)** | Same API, dense semantic vectors suitable for cosine search |
| Vector DB | **PostgreSQL + pgvector** | No separate infra, HNSW index for fast ANN search, JSONB for persona storage |
| Audio download | **yt-dlp** (`.venv/bin/yt-dlp`) | Supports YouTube, Apple Podcasts, Spotify, Vimeo, Anchor, and hundreds of other sources |
| Source discovery | **Linkup** (primary) + **Exa** (fallback) | Linkup returns structured search results; Exa provides neural search as backup |
| HTTP server | **Effect HttpApi** (`effect/unstable/httpapi`) | Type-safe endpoints, schema-validated payloads, OpenAPI generation |
| Transport (transcription) | **`node:https`** (HTTP/1.1) | Mistral's transcription endpoint rejects HTTP/2; `fetch`-based clients fail with `NGHTTP2_PROTOCOL_ERROR` |

---

## 4. System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        HTTP Layer                                │
│  GET /investors          GET /investors/:id                      │
│  POST /investors/ingest  POST /investors/match                   │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │    InvestorService    │  orchestration
                    └──┬──────────┬────────┘
                       │          │
          ┌────────────▼─┐   ┌────▼──────────┐
          │InvestorSources│   │  InvestorRepo  │
          │  Linkup / Exa │   │  PostgreSQL    │
          └───────────────┘   │  + pgvector    │
                              └────────────────┘
                    │
          ┌─────────▼──────────────────────┐
          │         External APIs           │
          │  Linkup   Exa   Mistral AI      │
          │  (search) (search) (LLM+embed)  │
          └────────────────────────────────┘
                    │
          ┌─────────▼──────────┐
          │   yt-dlp subprocess │
          │   audio/ folder     │
          └─────────────────────┘
```

---

## 5. Ingest Pipeline — Full Flow

```
POST /investors/ingest  { "name": "Marc Andreessen" }
```

### Step 1 — Source Discovery

`InvestorSources.searchInvestorSources(name)`

Builds query:
```
"Marc Andreessen investor interview site:youtube.com OR site:youtu.be OR ..."
```

1. Calls **Linkup** (`POST https://api.linkup.so/v1/search`, `outputType: "searchResults"`)
2. If Linkup returns 0 results → falls back to **Exa** (`POST https://api.exa.ai/search`, neural search)
3. Deduplicates results by URL

**Why Linkup first?** Linkup returns structured `{ url, name, content, type }` records with better relevance for named entity queries. Exa is a strong semantic fallback.

---

### Step 2 — URL Selection

`pickBestUrl(results)`

Priority order:
1. Any URL matching known audio/video domains (YouTube, Vimeo, Spotify, Anchor, Buzzsprout, Simplecast, Transistor)
2. Any URL **not** matching article-only domains (Wikipedia, LinkedIn, Twitter, Crunchbase, news sites)
3. If nothing passes → `PipelineError: No audio/video source found`

**Why exclude article domains?** yt-dlp cannot extract audio from Wikipedia, LinkedIn, or news articles. Passing those URLs causes a silent failure (exit code 1) rather than a useful error.

---

### Step 3 — Audio Extraction

`InvestorService.extractAudio(url)`

#### What it does

Given the selected URL, download the audio track as an MP3 and save it locally for transcription.

#### Example — Primary path (RSS direct download)

For Apple Podcasts URLs, the system resolves the real `.mp3` without any scraping:

```
Input:   https://podcasts.apple.com/us/podcast/marc-andreessen-.../id1154105909?i=1000691052043

Step 1:  iTunes Lookup API (no key required)
         GET https://itunes.apple.com/lookup?id=1154105909&entity=podcast
         → { feedUrl: "https://feeds.simplecast.com/JGE3yC0V" }

Step 2:  Parse RSS feed (rss-parser)
         <enclosure url="https://cdn.simplecast.com/audio/abc123.mp3" type="audio/mpeg" />
         Best match by keyword score against investor name

Step 3:  Direct download
         GET https://cdn.simplecast.com/audio/abc123.mp3
         → audio/investor-1718668800000.mp3
```

No Python, no yt-dlp, no scraping — just HTTP and RSS parsing.

#### Example — Fallback path (yt-dlp)

When the source is a YouTube video or RSS resolution returns nothing, yt-dlp handles extraction:

```bash
yt-dlp -x --audio-format mp3 --audio-quality 0 \
  "https://youtube.com/watch?v=abc123" \
  -o "audio/investor-1718668800000.mp3"
```

#### How it works in code

`extractAudio` tries the RSS path first via `resolveRssAudio` (`src/domains/investor/investor.rss.ts`). If it returns an audio URL, the file is streamed directly with `fetch`. If it returns `undefined`, yt-dlp is spawned as a subprocess fallback. Both paths write to the same `audio/` output path.

```typescript
const extractAudio = Effect.fn("InvestorService.extractAudio")(function*(url: string, nameHint: string) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
  const outPath = path.join(AUDIO_DIR, `investor-${Date.now()}.mp3`)

  const rss = yield* resolveRssAudio(url, nameHint)   // investor.rss.ts
  if (rss !== undefined) {
    // RSS path: fetch .mp3 directly
    yield* Effect.tryPromise({
      try: async () => {
        const res    = await fetch(rss.audioUrl)
        const buffer = Buffer.from(await res.arrayBuffer())
        fs.writeFileSync(outPath, buffer)
      },
      catch: (e) => e as Error
    }).pipe(Effect.orDie)
  } else {
    // Fallback: yt-dlp subprocess (.venv/bin/yt-dlp)
    yield* Effect.tryPromise({
      try:   () => ytDlp(url, outPath),
      catch: (e) => e as Error
    }).pipe(Effect.timeout("90 seconds"), Effect.orDie)
  }

  return outPath
})
```

#### `resolveRssAudio` — how the RSS resolver works (`investor.rss.ts`)

```
resolveRssAudio(sourceUrl, nameHint)
  │
  ├─ Apple Podcasts URL?
  │     → extract podcast ID from URL
  │     → GET itunes.apple.com/lookup?id=<id>&entity=podcast
  │     → feedUrl from response
  │
  ├─ Already an RSS feed URL? (.xml / /feed / /rss)
  │     → use directly
  │
  └─ rss-parser.parseURL(feedUrl)
        → score each episode by keyword match against nameHint
        → return highest-scoring enclosure URL
        → if no match, return first episode with an enclosure
        → on any error, return undefined (silent fallback to yt-dlp)
```

File output: `audio/investor-<timestamp>.mp3`

#### Approach summary

| Approach | Triggers when | Dependencies |
|---|---|---|
| RSS → iTunes API → feed → `.mp3` | Source is an Apple Podcasts URL | `rss-parser` (npm), `fetch` |
| yt-dlp subprocess | RSS returns nothing, or source is YouTube/Vimeo/etc. | `.venv/bin/yt-dlp` (Python) |

---

### Step 4 — Transcription

`InvestorService.transcribe(audioPath)`

Uses **Mistral Voxtral** (`voxtral-mini-2507`) via a raw `node:https` multipart POST:

```
POST https://api.mistral.ai/v1/audio/transcriptions
Content-Type: multipart/form-data; boundary=...

model=voxtral-mini-2507
file=<audio bytes>
```

**Why `node:https` and not `fetch`/Effect HTTP client?**
Mistral's transcription endpoint rejects HTTP/2 connections with `NGHTTP2_PROTOCOL_ERROR`. The Effect HTTP client and `fetch` both default to HTTP/2 for HTTPS. Using `node:https` directly forces HTTP/1.1.

After transcription:
- `cleanTranscript()` strips filler words (`um`, `uh`, `like`, `you know`) and collapses whitespace
- Saves cleaned transcript to `transcriptions/investor-<timestamp>.txt`, line-wrapped at 120 chars
- Returns the cleaned string for the next pipeline stage

---

### Step 5 — Persona Extraction (parallel)

`InvestorService.extractPersona(transcript)`

Runs **two LLM calls in parallel** using `Effect.all(..., { concurrency: "unbounded" })`:

#### 5a — Sentiment Analysis

Prompt: `src/prompts/sentiment-analysis.md` (placeholder: `{{text}}`)

Extracts:
```json
{
  "overall": "positive|neutral|negative|mixed",
  "confidence": "high|medium|low",
  "riskAppetite": "aggressive|moderate|conservative",
  "founderEmpathy": "high|medium|low",
  "keySignals": ["direct quote 1", "direct quote 2", ...]
}
```

#### 5b — Persona Base

Prompt: `src/prompts/extract-persona.md` (placeholder: `{{transcript}}`)

Extracts:
```json
{
  "thesis": "What they fund, at what stage, and why",
  "style": "How they communicate",
  "sectors": ["array", "of", "conviction", "areas"],
  "aversion": ["what", "they", "avoid"],
  "tone": "How they engage with founders"
}
```

**Why `generateText` + JSON parse instead of `generateObject`?**
The `@effect/ai-openai-compat` library uses tool-call mode for `generateObject`. Mistral returns `"tool_calls": null` (not absent) in non-tool responses, which fails the library's schema (`Schema.Array` cannot accept `null`). We use `generateText` and parse the JSON output manually, stripping any markdown fences first.

Both results are merged into a single `Persona` object with the `Sentiment` embedded.

---

### Step 6 — Embedding

`embedModel.embed(personaText)`

Embeds a condensed string:
```
"<thesis> <sector1> <sector2> ... <style>"
```

Model: `mistral-embed` → **1024-dimensional vector**

**Why embed thesis + sectors + style only?**
Shorter, denser signal. The full transcript would add noise. The thesis and sectors are the most discriminating features for matching.

---

### Step 7 — Storage

`InvestorRepo.insert(...)`

Inserts into `investor_profile`:
```sql
INSERT INTO investor_profile (name, source_url, transcript, persona, embedding)
VALUES ($1, $2, $3, $4::jsonb, $5::vector)
RETURNING id, created_at
```

- `persona` stored as **JSONB** — queryable, human-readable
- `embedding` stored as **vector(1024)** — indexed with HNSW for cosine search
- Returns the full `Investor` record as the HTTP response

---

## 6. Matching Pipeline — Full Flow

```
POST /investors/match
{
  "companyName": "NeuralOps",
  "stage": "seed",
  "sectors": ["ai", "enterprise-software", "developer-tools", "infrastructure"],
  "pitch": "We build open-source LLM ops platform...",
  "limit": 10
}
```

### Step 1 — Embed Founder Profile

Builds embed text:
```
"<companyName> <stage> <sector1> <sector2> ... <pitch>"
```

Embeds with `mistral-embed` → `founderVec` (1024 dims)

**Why include the pitch?** The pitch text adds semantic context beyond just sector labels. The embedding captures *how* the founder describes their work, which aligns better with *how* the investor talks about their thesis.

---

### Step 2 — Vector Search

`InvestorRepo.similarTo(founderVec, limit)`

```sql
SELECT id, name,
       1 - (embedding <=> $1::vector) AS similarity,
       persona->'sectors' AS sectors
FROM investor_profile
WHERE embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $2
```

- `<=>` is **cosine distance** (pgvector operator)
- `1 - distance` converts to **cosine similarity** (0–1, higher = more similar)
- HNSW index makes this sub-millisecond even at large scale
- Returns `sectors` from JSONB for structured scoring

---

### Step 3 — Dual Scoring

For each candidate investor:

#### Persona Score (semantic)
```
personaScore = cosine similarity from pgvector (0–1)
```
Measures how semantically close the founder's overall pitch is to the investor's distilled persona.

#### Structured Score (sector overlap)
```
founderTags   = founder sectors, lowercased, hyphens → spaces
investorText  = all investor sector phrases joined, lowercased
matched       = tags where: investorText.includes(tag)
                         OR all words in tag appear in investorText

structuredScore = matched.length / founderTags.length
```

**Why keyword matching instead of exact equality?**
The LLM extracts investor sectors as verbose phrases: `"AI and machine learning (especially open-source and reasoning models)"`. Founder tags are short tokens: `"ai"`. Substring + word-bag matching bridges this gap without requiring normalization of the LLM output.

#### Final Score
```
finalScore = 0.5 × structuredScore + 0.5 × personaScore
```

Equal weight by default. The semantic score catches investors whose *language* aligns even when sector tags don't perfectly match; the structured score rewards explicit sector overlap.

---

## 7. Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

CREATE TABLE investor_profile (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  source_url  text        NOT NULL,
  transcript  text,
  persona     jsonb       NOT NULL,
  embedding   vector(1024),
  created_at  timestamptz DEFAULT now()
);

-- HNSW index for approximate nearest neighbor cosine search
CREATE INDEX investor_embedding_hnsw_idx
  ON investor_profile
  USING hnsw (embedding vector_cosine_ops);
```

**Why HNSW over IVFFlat?**
HNSW (Hierarchical Navigable Small World) has better recall at low result counts and doesn't require a training/probing step. For a growing investor dataset it's the right default.

**Why JSONB for persona?**
- Queryable: `persona->'sectors'` extracts sectors without deserializing the whole object
- Human-readable in psql
- Schema can evolve without migrations (add new persona fields without ALTER TABLE)

---

## 8. Service Layer Reference

### `AppConfig`

Loads all secrets and config from environment variables. All sensitive values are `Redacted` — they never appear in logs or traces.

| Key | Type | Default |
|---|---|---|
| `DATABASE_URL` | `Redacted` | — |
| `MISTRAL_API_KEY` | `Redacted` | — |
| `LINKUP_API_KEY` | `Redacted` | — |
| `EXA_API_KEY` | `Redacted` | — |
| `PORT` | `number` | `3000` |

---

### `Core`

Wraps the PostgreSQL connection and runs schema migrations on startup via `Layer.unwrap`. The `Layer.unwrap` pattern is needed because the DB URL comes from `AppConfig` which is itself a layer — it must be resolved before `pgLayer` can be constructed.

Provides `SqlClient` (tagged template SQL) and `PgClient` (for `pg.json()` JSONB encoding).

---

### `InvestorSources`

| Method | Description |
|---|---|
| `searchLinkup(query)` | `POST https://api.linkup.so/v1/search` — `outputType: "searchResults"` returns `{ results: [{ url, name, content, type }] }` |
| `searchExa(query)` | `POST https://api.exa.ai/search` — neural search, returns `{ results: [{ url, title }] }` |
| `searchInvestorSources(name)` | Linkup → Exa fallback, deduped by URL |

---

### `InvestorRepo`

| Method | SQL | Notes |
|---|---|---|
| `insert` | `INSERT ... RETURNING` | Encodes persona as JSONB via `pg.json()` |
| `findById` | `SELECT WHERE id = $1` | Returns `InvestorNotFound` if missing |
| `listAll` | `SELECT ORDER BY created_at DESC` | All records |
| `similarTo` | `ORDER BY embedding <=> $1::vector LIMIT $2` | Cosine ANN via HNSW |

---

### `InvestorService`

| Method | Signature | Description |
|---|---|---|
| `ingestByName` | `{ name } → Effect<Investor, PipelineError>` | Full pipeline: search → download → transcribe → extract → embed → store |
| `ingestFromUrl` | `{ name, url } → Effect<Investor>` | Skip source search, use known URL |
| `getById` | `id → Effect<Investor, InvestorError>` | Lookup by UUID |
| `listAll` | `() → Effect<Investor[]>` | All stored investors |
| `matchFounder` | `FounderProfile → Effect<MatchResult[]>` | Embed + ANN search + dual score |
| `searchSources` | `name → Effect<SourceResult[]>` | Expose raw search without ingest |

The service layer is wired via `Layer.unwrap` for the LLM/embedding client (same `Layer.unwrap` pattern as `Core`) since the Mistral API key must be resolved from `AppConfig` before the OpenAI-compat client layer can be constructed.

---

## 9. HTTP API Reference

### `GET /investors`
List all ingested investors ordered by `created_at DESC`.

**Response 200**
```json
[{ "id": "uuid", "name": "...", "sourceUrl": "...", "persona": {...}, "createdAt": "..." }]
```

---

### `GET /investors/:id`
Get investor by UUID.

**Response 200** — `Investor`
**Response 404** — `InvestorNotFound`

---

### `POST /investors/ingest`
Trigger the full ingest pipeline for an investor by name.

**Request**
```json
{ "name": "Marc Andreessen" }
```

**Response 200** — full `Investor` with extracted persona
**Response 422** — `PipelineError` (no source found, yt-dlp failed, transcription failed)

---

### `POST /investors/match`
Find investors that match a founder's profile.

**Request**
```json
{
  "companyName": "NeuralOps",
  "stage": "seed",
  "sectors": ["ai", "enterprise-software", "developer-tools"],
  "pitch": "We build open-source LLM ops platform...",
  "limit": 10
}
```

`stage`: `pre-seed` | `seed` | `series-a` | `series-b` | `growth`
`limit`: optional, default `10`

**Response 200**
```json
[{
  "investorId": "uuid",
  "investorName": "Marc Andreessen",
  "structuredScore": 0.5,
  "personaScore": 0.796,
  "finalScore": 0.648
}]
```

Sorted by pgvector cosine distance (closest first).

---

### `GET /health`
Health check, returns `204 No Content`.

---

## 10. Data Models

### `Investor`
| Field | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `name` | string | Investor name |
| `sourceUrl` | string | URL audio was sourced from |
| `persona` | `Persona` | Full extracted persona (JSONB in DB) |
| `createdAt` | string | ISO timestamp |

### `Persona`
| Field | Type | Description |
|---|---|---|
| `thesis` | string | Investment thesis and stage focus |
| `style` | string | Communication style |
| `sectors` | string[] | Sectors of conviction (LLM-extracted phrases) |
| `aversion` | string[] | What they avoid or have passed on |
| `tone` | string | How they engage with founders |
| `sentiment` | `Sentiment` | Emotional posture analysis |

### `Sentiment`
| Field | Values | Description |
|---|---|---|
| `overall` | `positive` \| `neutral` \| `negative` \| `mixed` | Overall tone |
| `confidence` | `high` \| `medium` \| `low` | How self-assured they sound |
| `riskAppetite` | `aggressive` \| `moderate` \| `conservative` | Attitude toward risk |
| `founderEmpathy` | `high` \| `medium` \| `low` | Empathy toward founders |
| `keySignals` | string[] (max 5) | Direct quotes revealing attitude |

### `FounderProfile` (match input)
| Field | Type | Description |
|---|---|---|
| `companyName` | string | Company name |
| `stage` | string | Current funding stage |
| `sectors` | string[] | Short sector tags (e.g. `"ai"`, `"fintech"`) |
| `pitch` | string | One-paragraph pitch |
| `limit` | int? | Max results (default 10) |

### `MatchResult`
| Field | Type | Description |
|---|---|---|
| `investorId` | UUID | Investor ID |
| `investorName` | string | Investor name |
| `structuredScore` | 0–1 | Sector keyword overlap ratio |
| `personaScore` | 0–1 | Embedding cosine similarity |
| `finalScore` | 0–1 | `0.5 × structured + 0.5 × persona` |

---

## 11. File Outputs

| Path | Created by | Content |
|---|---|---|
| `audio/investor-<timestamp>.mp3` | `extractAudio` | Raw MP3 from yt-dlp |
| `transcriptions/investor-<timestamp>.txt` | `transcribe` | Cleaned transcript, 120-char line-wrapped |

Both directories are created automatically on first use (`mkdirSync recursive`). Both are git-ignored with `.gitkeep` markers.

---

## 12. Prompts

Located in `src/prompts/`. Loaded once at startup via `fs.readFileSync`.

### `extract-persona.md`
Placeholder: `{{transcript}}`
Instructs the LLM to extract thesis, style, sectors, aversion, and tone as raw JSON.

### `sentiment-analysis.md`
Placeholder: `{{text}}`
Instructs the LLM to score overall sentiment, confidence, risk appetite, founder empathy, and key signal quotes as raw JSON.

Both prompts explicitly instruct the model to return **raw JSON only** with a concrete shape example — no markdown, no preamble. The response is strip-decoded (remove any ` ``` ` fences) before `JSON.parse`.

---

## 13. Known Constraints & Decisions

| Constraint | Decision |
|---|---|
| Mistral transcription rejects HTTP/2 | Use `node:https` directly for the multipart upload |
| `@effect/ai-openai-compat` schema fails on `tool_calls: null` from Mistral | Patched `node_modules` dist: `NullOr(Array(...))` + null guards in `makeResponse` |
| LLM sectors are verbose phrases, founder tags are short tokens | Keyword substring + word-bag matching in `matchFounder` |
| Apple Podcasts and Spotify URLs work with yt-dlp | Kept in `VIDEO_URL_RE`; only pure article sites are excluded |
| `generateObject` uses tool-call mode which Mistral doesn't support correctly | Use `generateText` + manual JSON parse for all structured outputs |
