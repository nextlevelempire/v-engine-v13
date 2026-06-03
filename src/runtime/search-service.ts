/**
 * search-service.ts — Web search for the V-Engine.
 *
 * Two modes:
 *   1. SerpAPI (preferred): structured JSON results, no browser needed.
 *      Requires OMNI_SERPAPI_KEY env var.
 *   2. Browser fallback: navigates to Google/Bing/DuckDuckGo and extracts
 *      results from the AX tree. Works without an API key.
 *
 * New command: { type: "search", query: "...", engine: "google|bing|ddg|news", num_results: 10 }
 * Returns: { ok: true, results: [{ title, url, snippet }], source: "serpapi"|"browser" }
 */

import type { Page } from "playwright";
import { captureAXObservation } from "./omni-ax-observer.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  position?: number;
}

export interface SearchResponse {
  ok: boolean;
  query: string;
  engine: string;
  results: SearchResult[];
  source: "serpapi" | "browser" | "error";
  error?: string;
}

export type SearchEngine = "google" | "bing" | "ddg" | "news";

const SERPAPI_KEY = () => process.env.OMNI_SERPAPI_KEY?.trim() ?? "";

/** Run a web search. Uses SerpAPI if key present, otherwise browser fallback. */
export async function runSearch(
  page: Page,
  query: string,
  engine: SearchEngine = "google",
  numResults = 10,
): Promise<SearchResponse> {
  const key = SERPAPI_KEY();
  if (key) {
    return searchViaSerpApi(query, engine, numResults, key);
  }
  return searchViaBrowser(page, query, engine, numResults);
}

// ── SerpAPI ───────────────────────────────────────────────────────────────────

async function searchViaSerpApi(
  query: string,
  engine: SearchEngine,
  num: number,
  apiKey: string,
): Promise<SearchResponse> {
  const serpEngine = engine === "news" ? "google" : engine === "ddg" ? "duckduckgo" : engine;
  const params = new URLSearchParams({
    api_key: apiKey,
    engine: serpEngine,
    q: query,
    num: String(Math.min(num, 20)),
    ...(engine === "news" ? { tbm: "nws" } : {}),
  });
  try {
    const resp = await fetch(`https://serpapi.com/search?${params.toString()}`);
    if (!resp.ok) throw new Error(`SerpAPI ${resp.status}`);
    const data = (await resp.json()) as {
      organic_results?: Array<{ title?: string; link?: string; snippet?: string; position?: number }>;
      news_results?: Array<{ title?: string; link?: string; snippet?: string; position?: number }>;
    };
    const raw = data.news_results ?? data.organic_results ?? [];
    const results: SearchResult[] = raw.slice(0, num).map((r, i) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: r.snippet ?? "",
      position: r.position ?? i + 1,
    }));
    return { ok: true, query, engine, results, source: "serpapi" };
  } catch (err) {
    return { ok: false, query, engine, results: [], source: "error", error: String(err) };
  }
}

// ── Browser fallback ──────────────────────────────────────────────────────────

const ENGINE_URLS: Record<SearchEngine, (q: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=20`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  ddg: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`,
  news: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=nws`,
};

async function searchViaBrowser(
  page: Page,
  query: string,
  engine: SearchEngine,
  num: number,
): Promise<SearchResponse> {
  try {
    await page.goto(ENGINE_URLS[engine](query), { waitUntil: "domcontentloaded", timeout: 12000 });
    await page.waitForTimeout(1500);

    // Extract from DOM for Google
    if (engine === "google" || engine === "news") {
      const results = await extractGoogleResults(page, num);
      return { ok: true, query, engine, results, source: "browser" };
    }
    if (engine === "bing") {
      const results = await extractBingResults(page, num);
      return { ok: true, query, engine, results, source: "browser" };
    }
    // DuckDuckGo + fallback: use AX tree
    const obs = await captureAXObservation(page);
    const results = parseResultsFromAxTree(obs.axTree, num);
    return { ok: true, query, engine, results, source: "browser" };
  } catch (err) {
    return { ok: false, query, engine, results: [], source: "error", error: String(err) };
  }
}

async function extractGoogleResults(page: Page, num: number): Promise<SearchResult[]> {
  return page.evaluate((maxN) => {
    const items: { title: string; url: string; snippet: string; position: number }[] = [];
    const cards = document.querySelectorAll("div.g, div[data-sokoban-container]");
    let pos = 1;
    for (const card of Array.from(cards).slice(0, maxN * 2)) {
      const a = card.querySelector("a[href]") as HTMLAnchorElement | null;
      const titleEl = card.querySelector("h3");
      const snippetEl = card.querySelector(".VwiC3b, .IsZvec span, div[style*='-webkit-line-clamp']");
      if (!a || !titleEl) continue;
      const url = a.href;
      if (!url.startsWith("http") || url.includes("google.com/search")) continue;
      items.push({ title: titleEl.innerText.trim(), url, snippet: (snippetEl as HTMLElement | null)?.innerText?.trim() ?? "", position: pos++ });
      if (items.length >= maxN) break;
    }
    return items;
  }, num);
}

async function extractBingResults(page: Page, num: number): Promise<SearchResult[]> {
  return page.evaluate((maxN) => {
    const items: { title: string; url: string; snippet: string; position: number }[] = [];
    const cards = document.querySelectorAll("li.b_algo");
    let pos = 1;
    for (const card of Array.from(cards).slice(0, maxN)) {
      const a = card.querySelector("h2 a") as HTMLAnchorElement | null;
      const snippetEl = card.querySelector(".b_caption p");
      if (!a) continue;
      items.push({ title: a.innerText.trim(), url: a.href, snippet: (snippetEl as HTMLElement | null)?.innerText?.trim() ?? "", position: pos++ });
    }
    return items;
  }, num);
}

function parseResultsFromAxTree(axTree: string, num: number): SearchResult[] {
  const results: SearchResult[] = [];
  const lines = axTree.split("\n");
  for (const line of lines) {
    const urlMatch = line.match(/https?:\/\/[^\s)>]+/);
    if (!urlMatch) continue;
    const url = urlMatch[0];
    if (url.includes("duckduckgo.com") || url.includes("google.com/search")) continue;
    const title = line.replace(url, "").replace(/[[\]()]/g, "").trim().slice(0, 80) || url;
    results.push({ title, url, snippet: "", position: results.length + 1 });
    if (results.length >= num) break;
  }
  return results;
}
