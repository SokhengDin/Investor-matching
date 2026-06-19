import { Effect } from "effect"
import Parser from "rss-parser"

const parser = new Parser()

// Resolve an Apple Podcasts page URL to the show's RSS feed URL
// Uses Apple's iTunes Lookup API (no API key required)
function resolveApplePodcastsFeed(appleUrl: string): Promise<string | undefined> {
  const match = appleUrl.match(/id(\d+)/)
  if (!match) return Promise.resolve(undefined)
  const podcastId = match[1]
  return fetch(`https://itunes.apple.com/lookup?id=${podcastId}&entity=podcast`)
    .then((r) => r.json() as Promise<{ results: Array<{ feedUrl?: string }> }>)
    .then((data) => data.results[0]?.feedUrl)
}

// Find the best matching episode in a feed by keyword match on title
function findEpisode(
  items: Array<{ title?: string; enclosure?: { url?: string } }>,
  hint: string
): string | undefined {
  const keywords = hint.toLowerCase().split(/\s+/)
  const scored = items
    .filter((item) => item.enclosure?.url)
    .map((item) => {
      const title = (item.title ?? "").toLowerCase()
      const score = keywords.filter((kw) => title.includes(kw)).length
      return { url: item.enclosure!.url!, score }
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored[0]?.url ?? items.find((i) => i.enclosure?.url)?.enclosure?.url
}

export interface RssAudioResult {
  readonly audioUrl: string
  readonly feedUrl:  string
}

// Given an Apple Podcasts URL and the investor name as a search hint,
// resolve the RSS feed and return the best matching episode audio URL.
export const resolveRssAudio = (
  sourceUrl: string,
  nameHint:  string
): Effect.Effect<RssAudioResult | undefined> =>
  Effect.tryPromise({
    try: async () => {
      // Step 1: resolve feed URL
      let feedUrl: string | undefined
      if (/podcasts\.apple\.com/.test(sourceUrl)) {
        feedUrl = await resolveApplePodcastsFeed(sourceUrl)
      } else if (/\.xml$|\/feed|\/rss/.test(sourceUrl)) {
        feedUrl = sourceUrl
      }
      if (!feedUrl) return undefined

      // Step 2: parse feed and find episode
      const feed   = await parser.parseURL(feedUrl)
      const audioUrl = findEpisode(feed.items, nameHint)
      if (!audioUrl) return undefined

      return { audioUrl, feedUrl }
    },
    catch: () => undefined as RssAudioResult | undefined
  }).pipe(Effect.orElseSucceed(() => undefined))
