#!/usr/bin/env node
/**
 * seonix-seo-mcp — a free, open-source MCP server that lets ANY AI agent
 * (Claude Desktop, Cursor, Cline, …) AUDIT any website for SEO, GEO/AEO and
 * speed problems and report HOW IT SHOULD BE.
 *
 * Platform-agnostic: it works on WordPress, Shopify, custom, static — anything
 * reachable over HTTP. It is READ-ONLY. It SHOWS problems and gives CMS-neutral
 * recommendations ("the page should have a unique <title> of 30–60 chars…").
 * It NEVER modifies a live site — whether and how to fix is the user's job.
 *
 * Transport: stdio. No auth required for the core job. Optional env:
 *   PAGESPEED_API_KEY — enables Google PageSpeed Insights (Core Web Vitals +
 *   Lighthouse opportunities) on a small sample of pages. Without it, the
 *   server still runs always-on HTML speed heuristics on every fetched page.
 *
 * The legacy WordPress auto-fixers were moved out of the tool surface into
 * `src/extras/wordpress-fixers.ts` (kept for the record, not imported here).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  checkBoilerplateHeadings,
  checkBrokenInternalLinks,
  checkCrawlDepth,
  checkDuplicates,
  checkLlmsTxt,
  checkOrphanedPages,
  checkPage,
  checkPaginationNoindexRecommendation,
  checkRobotsAiBots,
  checkSpeedHeuristics,
  extractRobotsSitemaps,
  looksLikeXml,
  normalizeUrlKey,
  parsePage,
  parseSitemapXml,
  parsePsiResponse,
  psiToIssues,
  robotsAllows,
  type Issue,
  type IssueCategory,
  type PageData,
  type PsiApiResponse,
  type PsiSummary,
} from "./audit.js";
import { recommendationFor } from "./recommendations.js";
import { proposeFixes, previewFix, type FixProposal } from "./fixes.js";

const PKG_VERSION = "2.2.0";
const USER_AGENT = `seonix-seo-mcp/${PKG_VERSION} (+https://github.com/seonix-ai/seonix-mcp)`;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A user-actionable error whose message is safe to surface to the agent. */
class ToolError extends Error {}

// ---------------------------------------------------------------------------
// HTTP helpers (global fetch — no extra dependency)
// ---------------------------------------------------------------------------

interface FetchTextResult {
  status: number;
  finalUrl: string;
  body: string;
  headers: Headers;
}

/** Fetch a URL as text with a timeout, following redirects. Never throws on
 *  HTTP status — only on network/timeout failure (returns status 0 then). */
async function fetchText(url: string, timeoutMs = 20000): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain,*/*" },
    });
    const body = await res.text();
    return { status: res.status, finalUrl: res.url || url, body, headers: res.headers };
  } catch {
    return { status: 0, finalUrl: url, body: "", headers: new Headers() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a page following redirects MANUALLY so we can record the chain (needed
 * for broken_redirect / redirect_loop / too_many_redirects). Each 3xx hop is
 * recorded; the final response's body/status/url are returned. Caps at 10 hops.
 * Never throws on HTTP status — only network/timeout failure (status 0).
 */
async function fetchPage(
  url: string,
  timeoutMs = 20000,
): Promise<FetchTextResult & { redirectChain: { url: string; statusCode: number }[] }> {
  const chain: { url: string; statusCode: number }[] = [];
  let current = url;
  for (let hop = 0; hop < 10; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain,*/*" },
      });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        chain.push({ url: current, statusCode: res.status });
        try {
          current = new URL(loc, current).toString();
        } catch {
          // Unparseable Location — treat the 3xx as the final response.
          return { status: res.status, finalUrl: current, body: "", headers: res.headers, redirectChain: chain };
        }
        continue;
      }
      const body = await res.text();
      return { status: res.status, finalUrl: current, body, headers: res.headers, redirectChain: chain };
    } catch {
      return { status: 0, finalUrl: current, body: "", headers: new Headers(), redirectChain: chain };
    } finally {
      clearTimeout(timer);
    }
  }
  // Exceeded the hop cap — return a sentinel so too_many_redirects/loop fire.
  return { status: chain[chain.length - 1]?.statusCode ?? 0, finalUrl: current, body: "", headers: new Headers(), redirectChain: chain };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function normalizeSiteUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  // Drop trailing slash for consistent origin math.
  return s.replace(/\/+$/, "");
}

function originOf(siteUrl: string): string {
  const u = new URL(siteUrl);
  return `${u.protocol}//${u.host}`;
}

// ---------------------------------------------------------------------------
// Site discovery + crawlability checks (sitemap + robots.txt, one pass)
// ---------------------------------------------------------------------------

interface SiteDiscovery {
  /** Page URLs to audit (capped). */
  urls: string[];
  /** The sitemap (or "homepage-fallback") the URLs came from. */
  source: string;
  /** Normalized page URLs found in the sitemap(s), for the inSitemap flag. */
  sitemapSet: Set<string>;
  /** Crawlability findings: robots.txt + sitemap (group B). */
  siteIssues: Issue[];
  /** robots.txt HTTP status + body (null when not 2xx) — reused for AI-bot check. */
  robotsStatus: number;
  robotsBody: string | null;
}

const SITEMAP_DEFAULT_PATHS = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"];

/** Extract <loc>…</loc> values from a sitemap XML body. */
function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

const NESTED_SITEMAP_RE = /\.xml(\.gz)?($|\?)/i;
function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}
function ctIsXml(headers: Headers): boolean {
  return (headers.get("content-type") || "").toLowerCase().includes("xml");
}

/**
 * Discover page URLs AND run robots.txt + sitemap crawlability checks in one
 * pass (so we fetch robots/sitemaps once). Mirrors the scanner's
 * CheckCrawlability + CheckAEOSitemapQuality, minus the Googlebot-replay checks
 * (googlebot_blocked / googlebot_challenge) which need a UA spoof.
 */
async function discoverAndCheckSite(siteUrl: string, cap: number): Promise<SiteDiscovery> {
  const origin = originOf(siteUrl);
  const siteIssues: Issue[] = [];

  // --- robots.txt ---
  const robotsRes = await fetchText(`${origin}/robots.txt`);
  const robotsOk = robotsRes.status >= 200 && robotsRes.status < 300;
  const robotsBody = robotsOk ? robotsRes.body : "";
  const robotsUrl = `${origin}/robots.txt`;

  if (robotsRes.status === 404) {
    siteIssues.push({ code: "robots_missing", severity: "notice", url: robotsUrl, message: "No robots.txt found at the site root.", evidence: { status: 404 } });
  }
  if (robotsOk && !robotsAllows(robotsBody, "Googlebot", "/")) {
    siteIssues.push({ code: "robots_blocks_all", severity: "error", url: robotsUrl, message: "robots.txt disallows Googlebot from crawling the site root.", evidence: { checked_url: `${origin}/`, user_agent: "Googlebot" } });
  }

  const declared = robotsOk ? [...new Set(extractRobotsSitemaps(robotsBody))] : [];
  const candidates = [...new Set([...declared, ...SITEMAP_DEFAULT_PATHS.map((p) => origin + p)])];

  if (robotsOk) {
    for (const sm of candidates) {
      if (!robotsAllows(robotsBody, "Googlebot", pathOf(sm))) {
        siteIssues.push({ code: "robots_blocks_sitemap_path", severity: "warning", url: sm, message: "robots.txt disallows the path to this sitemap.", evidence: { sitemap_url: sm } });
      }
    }
  }

  // --- sitemap probing + URL discovery + lastmod coverage ---
  const collected = new Set<string>();
  let source = "homepage-fallback";
  let anyWorking = false;
  let lastmodTotal = 0;
  let lastmodWith = 0;
  let emittedUnreachable = false;
  let firstWorkingSitemap = "";
  let polite = false;

  for (const sm of candidates) {
    if (anyWorking && collected.size >= cap) break;
    if (polite) await sleep(1000);
    polite = true;
    const res = await fetchText(sm);
    const ok2xx = res.status >= 200 && res.status < 300;
    const isDeclared = declared.includes(sm);

    if (!ok2xx) {
      // Only flag an explicitly-declared sitemap that fails; a missing default
      // path (most sites have just one) is handled by the no-sitemap fallback.
      if (isDeclared) {
        siteIssues.push({ code: "sitemap_unreachable", severity: "error", url: sm, message: `Sitemap returned HTTP ${res.status || "(network error)"}.`, evidence: { url: sm, status_seonix: res.status } });
        emittedUnreachable = true;
      }
      continue;
    }
    if (!looksLikeXml(res.body) && !ctIsXml(res.headers)) {
      siteIssues.push({ code: "sitemap_invalid_xml", severity: "error", url: sm, message: "Sitemap returned 200 but the body is not XML.", evidence: { url: sm, content_type: res.headers.get("content-type") || "" } });
      continue;
    }
    const parsed = parseSitemapXml(res.body);
    if (parsed.kind === "unknown") {
      siteIssues.push({ code: "sitemap_invalid_xml", severity: "error", url: sm, message: "Sitemap XML root is not <urlset> or <sitemapindex>.", evidence: { url: sm } });
      continue;
    }

    anyWorking = true;
    if (firstWorkingSitemap === "") firstWorkingSitemap = sm;
    if (source === "homepage-fallback") source = sm;

    if (parsed.kind === "urlset") {
      if (parsed.urlCount === 0) {
        siteIssues.push({ code: "sitemap_empty", severity: "warning", url: sm, message: "Sitemap parses but contains zero URLs.", evidence: { url: sm } });
      }
      lastmodTotal += parsed.urlCount;
      lastmodWith += parsed.lastmodCount;
      for (const loc of extractLocs(res.body)) {
        if (collected.size >= cap) break;
        if (!NESTED_SITEMAP_RE.test(loc)) collected.add(loc);
      }
    } else {
      // sitemap index — descend one level into child sitemaps.
      if (parsed.childLocs.length === 0) {
        siteIssues.push({ code: "sitemap_empty", severity: "warning", url: sm, message: "Sitemap index references zero child sitemaps.", evidence: { url: sm } });
      }
      let childFailed = false;
      for (const child of parsed.childLocs) {
        if (collected.size >= cap) break;
        await sleep(1000);
        const c = await fetchText(child);
        if (c.status < 200 || c.status >= 300) {
          childFailed = true;
          continue;
        }
        const cp = parseSitemapXml(c.body);
        lastmodTotal += cp.urlCount;
        lastmodWith += cp.lastmodCount;
        for (const loc of extractLocs(c.body)) {
          if (collected.size >= cap) break;
          if (!NESTED_SITEMAP_RE.test(loc)) collected.add(loc);
        }
      }
      if (childFailed) {
        siteIssues.push({ code: "sitemap_index_children_failed", severity: "error", url: sm, message: "Sitemap index opens but one or more child sitemaps could not be fetched.", evidence: { url: sm } });
      }
    }
  }

  // No sitemap reachable at all → flag the canonical /sitemap.xml once.
  if (!anyWorking && !emittedUnreachable) {
    siteIssues.push({ code: "sitemap_unreachable", severity: "error", url: `${origin}/sitemap.xml`, message: "No reachable sitemap found (tried robots.txt declarations and the common default paths).", evidence: { tried: candidates } });
  }

  // sitemap_not_declared_in_robots: a working sitemap exists but robots.txt
  // (present) never declared it.
  if (declared.length === 0 && anyWorking && robotsRes.status === 200) {
    siteIssues.push({ code: "sitemap_not_declared_in_robots", severity: "notice", url: robotsUrl, message: "A working sitemap exists but robots.txt has no Sitemap: directive.", evidence: { sitemap_url: firstWorkingSitemap } });
  }

  // aeo_sitemap_lastmod_missing: <80% of URLs carry a <lastmod>.
  if (lastmodTotal > 0 && lastmodWith / lastmodTotal < 0.8) {
    siteIssues.push({
      code: "aeo_sitemap_lastmod_missing",
      category: "aeo",
      severity: "notice",
      url: firstWorkingSitemap || `${origin}/sitemap.xml`,
      message: `Only ${Math.round((lastmodWith / lastmodTotal) * 100)}% of sitemap URLs carry a <lastmod> (recommended 80%+).`,
      evidence: { total_urls: lastmodTotal, urls_with_lastmod: lastmodWith, coverage_percent: Math.round((lastmodWith / lastmodTotal) * 100) },
    });
  }

  const urls = collected.size === 0 ? [origin + "/"] : [...collected].slice(0, cap);
  const sitemapSet = new Set([...collected].map((u) => normalizeUrlKey(u)));
  return { urls, source, sitemapSet, siteIssues, robotsStatus: robotsRes.status, robotsBody: robotsOk ? robotsBody : null };
}

// ---------------------------------------------------------------------------
// PageSpeed Insights (optional — only when PAGESPEED_API_KEY is set)
// ---------------------------------------------------------------------------

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

function pagespeedApiKey(): string {
  return (process.env.PAGESPEED_API_KEY || "").trim();
}

/**
 * Run PSI (mobile strategy) for one URL and return both the CWV summary and
 * the derived speed issues. Returns null on any failure — the audit must never
 * fail just because PSI was slow or rate-limited.
 */
async function runPsi(url: string): Promise<{ summary: PsiSummary; issues: Issue[] } | null> {
  const key = pagespeedApiKey();
  if (!key) return null;
  const endpoint =
    `${PSI_ENDPOINT}?url=${encodeURIComponent(url)}&strategy=mobile` +
    `&category=PERFORMANCE&key=${encodeURIComponent(key)}`;

  // PSI runs a full server-side Lighthouse audit; 10-30s is normal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);
  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as PsiApiResponse;
    const summary = parsePsiResponse(raw, url, "mobile");
    if (!summary) return null;
    return { summary, issues: psiToIssues(raw, url) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick a small, representative sample of pages to run PSI against: always the
 * homepage (first URL), then spread the remaining slots across the list so the
 * sample isn't all sibling pages. PSI is slow, so the sample stays small.
 */
function sampleForSpeed(urls: string[], sampleSize: number): string[] {
  if (sampleSize <= 0 || urls.length === 0) return [];
  if (urls.length <= sampleSize) return [...urls];
  const picked = [urls[0]];
  const remaining = sampleSize - 1;
  if (remaining > 0) {
    const step = (urls.length - 1) / remaining;
    for (let i = 1; i <= remaining; i++) {
      const idx = Math.min(urls.length - 1, Math.round(i * step));
      const u = urls[idx];
      if (!picked.includes(u)) picked.push(u);
    }
  }
  return picked.slice(0, sampleSize);
}

// ---------------------------------------------------------------------------
// audit_site
// ---------------------------------------------------------------------------

/** A flat issue enriched with its "how it should be" recommendation. */
interface EnrichedIssue {
  code: string;
  category: IssueCategory;
  severity: Issue["severity"];
  url: string;
  evidence: Record<string, unknown>;
  why: string;
  target_state: string;
  recommendation: string;
}

interface PillarSummary {
  score: number; // 0..100
  health_label: "good" | "needs work" | "poor";
  issue_count: number;
}

interface AuditResult {
  site_url: string;
  pages_scanned: number;
  sitemap_source: string;
  speed: {
    enabled_pagespeed: boolean;
    pages_measured: number;
    measurements: PsiSummary[];
  };
  summary: { seo: PillarSummary; aeo: PillarSummary; speed: PillarSummary };
  issue_count: number;
  issues_by_severity: Record<string, number>;
  issues: EnrichedIssue[];
}

interface AuditOptions {
  maxPages: number;
  speedSample: number;
}

async function runAudit(siteUrlRaw: string, opts: AuditOptions): Promise<AuditResult> {
  const siteUrl = normalizeSiteUrl(siteUrlRaw);
  const cap = Math.max(1, Math.min(opts.maxPages, 100));

  const { urls, source, sitemapSet, siteIssues, robotsStatus, robotsBody } = await discoverAndCheckSite(siteUrl, cap);

  const rawIssues: Issue[] = [];
  const pages: PageData[] = [];

  // Polite, sequential page fetches (~1 req/sec) — this is a read-only audit
  // against a stranger's site; we do not hammer it. HTML checks (SEO + AEO +
  // always-on speed heuristics) run on every fetched page. We follow redirects
  // manually so each page carries its redirect chain.
  for (let i = 0; i < urls.length; i++) {
    if (i > 0) await sleep(1000);
    const url = urls[i];
    const res = await fetchPage(url);
    if (res.status === 0 && res.redirectChain.length === 0) {
      rawIssues.push({ code: "fetch_failed", category: "seo", severity: "error", url, message: "Could not fetch the page (network error or timeout)." });
      continue;
    }
    const page = parsePage(res.body, url, {
      statusCode: res.status,
      finalUrl: res.finalUrl,
      xRobotsTag: res.headers.get("x-robots-tag") || "",
    });
    // Fill the crawl metadata parsePage can't know from a single page's HTML.
    page.redirectChain = res.redirectChain;
    page.inSitemap = sitemapSet.has(normalizeUrlKey(url));
    pages.push(page);
    rawIssues.push(...checkPage(page));
  }

  // Cross-page checks (need the full page set): duplicates, boilerplate
  // headings, pagination noindex.
  rawIssues.push(...checkDuplicates(pages));
  rawIssues.push(...checkBoilerplateHeadings(pages));
  rawIssues.push(...checkPaginationNoindexRecommendation(pages));

  // Crawl-graph checks: broken internal links, orphaned pages, crawl depth.
  rawIssues.push(...checkBrokenInternalLinks(pages));
  rawIssues.push(...checkOrphanedPages(pages));
  rawIssues.push(...checkCrawlDepth(pages, siteUrl));

  // Crawlability findings (robots.txt + sitemap) gathered during discovery.
  rawIssues.push(...siteIssues);

  // Site-level checks: /llms.txt (one fetch) + robots.txt AI-bot block
  // (reusing the robots body already fetched during discovery).
  const llms = await fetchText(`${originOf(siteUrl)}/llms.txt`);
  rawIssues.push(...checkLlmsTxt(siteUrl, llms.status, llms.status >= 200 && llms.status < 300 ? llms.body : null));
  rawIssues.push(...checkRobotsAiBots(siteUrl, robotsStatus, robotsBody));

  // Speed via PSI (slow) — only a small representative sample, only when a key
  // is configured. Each measured page contributes Lighthouse-derived issues.
  const psiEnabled = pagespeedApiKey() !== "";
  const measurements: PsiSummary[] = [];
  if (psiEnabled) {
    const sample = sampleForSpeed(urls, opts.speedSample);
    for (let i = 0; i < sample.length; i++) {
      if (i > 0) await sleep(1000); // be polite to the PSI quota too
      const psi = await runPsi(sample[i]);
      if (psi) {
        measurements.push(psi.summary);
        rawIssues.push(...psi.issues);
      }
    }
  }

  // Enrich every issue with its recommendation + a definite category.
  const issues = rawIssues.map(enrichIssue);

  const bySeverity: Record<string, number> = { error: 0, warning: 0, notice: 0 };
  for (const issue of issues) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;

  const summary = {
    seo: pillarSummary(issues, "seo"),
    aeo: pillarSummary(issues, "aeo"),
    speed: speedPillarSummary(issues, measurements),
  };

  return {
    site_url: siteUrl,
    pages_scanned: urls.length,
    sitemap_source: source,
    speed: {
      enabled_pagespeed: psiEnabled,
      pages_measured: measurements.length,
      measurements,
    },
    summary,
    issue_count: issues.length,
    issues_by_severity: bySeverity,
    issues,
  };
}

/** Attach why / target_state / recommendation + a definite category. */
function enrichIssue(issue: Issue): EnrichedIssue {
  const rec = recommendationFor(issue.code, { category: issue.category, severity: issue.severity });
  return {
    code: issue.code,
    category: issue.category ?? rec.category,
    severity: issue.severity,
    url: issue.url,
    evidence: issue.evidence ?? {},
    why: rec.why,
    target_state: rec.target_state,
    recommendation: rec.recommendation,
  };
}

/** Weighted demerit per severity used by the issue-based pillar score. */
const SEVERITY_WEIGHT: Record<Issue["severity"], number> = { error: 12, warning: 6, notice: 2 };

/**
 * Issue-based pillar score (SEO, AEO): start at 100 and subtract weighted
 * demerits, floored at 0. This is a transparent heuristic so an AI client can
 * relay a number to a human; it is not the dashboard's exact algorithm.
 */
function pillarSummary(issues: EnrichedIssue[], category: IssueCategory): PillarSummary {
  const mine = issues.filter((i) => i.category === category);
  let penalty = 0;
  for (const i of mine) penalty += SEVERITY_WEIGHT[i.severity];
  const score = Math.max(0, 100 - penalty);
  return { score, health_label: healthLabel(score), issue_count: mine.length };
}

/**
 * Speed pillar score: when PSI ran, it is the (rounded) median Lighthouse
 * performance score across measured pages — the same basis the Seonix
 * dashboard uses for the "Швидкість" pillar. Without PSI, fall back to the
 * issue-based heuristic over the always-on speed checks.
 */
function speedPillarSummary(issues: EnrichedIssue[], measurements: PsiSummary[]): PillarSummary {
  const speedIssueCount = issues.filter((i) => i.category === "speed").length;
  if (measurements.length > 0) {
    const scores = measurements.map((m) => m.performanceScore).sort((a, b) => a - b);
    const mid = Math.floor(scores.length / 2);
    const median = scores.length % 2 === 1 ? scores[mid] : Math.round((scores[mid - 1] + scores[mid]) / 2);
    return { score: median, health_label: healthLabel(median), issue_count: speedIssueCount };
  }
  return pillarSummary(issues, "speed");
}

/** Plain-language band for a 0–100 pillar score. */
function healthLabel(score: number): "good" | "needs work" | "poor" {
  if (score >= 80) return "good";
  if (score >= 50) return "needs work";
  return "poor";
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "audit_site",
    description:
      "READ-ONLY, platform-agnostic site auditor. Works on ANY website (WordPress, Shopify, custom, static — anything). Audits SEO, GEO/AEO and speed: it SHOWS problems and gives CMS-neutral 'how it should be' recommendations — it does NOT modify the site; you decide whether/how to fix. Discovers pages via sitemap.xml (polite ~1 req/sec, default 25 / max 100 pages), fetches each page's HTML (following redirects so it can flag redirect chains), and runs ~75 checks: " +
      "PER PAGE — title missing/length/HTML-entities/lowercase-start, meta description missing/length, image alt text, H1 count, emoji/overlong/before-H1/broken-hierarchy headings, low word count, no internal links, noindex, large page, soft-404, mixed content, canonical, viewport, Open Graph, structured-data validity; " +
      "GEO/AEO — JSON-LD Article author-not-Person / missing dates / duplicate-type / conflicting-data / unrecognized @type / incomplete Person, FAQ & HowTo schema not visible on-page, incomplete social tags, AI-restrictive meta robots, /llms.txt, robots.txt AI-bot blocking, sitemap lastmod coverage; " +
      "CROSS-PAGE / CRAWL — duplicate titles & meta descriptions, trailing-slash duplicates, boilerplate repeated headings, broken internal links, orphaned pages, crawl depth, redirect chains (broken/loop/too-many); " +
      "SITE — robots.txt missing/blocks-all/blocks-sitemap-path, sitemap unreachable/invalid/empty/index-children-failed/not-declared-in-robots; " +
      "SPEED — always-on HTML heuristics (render-blocking head resources, images missing width/height, un-lazy offscreen images, large inline blocks, page weight, DOM size), plus Google PageSpeed Insights (Core Web Vitals + Lighthouse opportunities) on a sample of pages when PAGESPEED_API_KEY is set. " +
      "Returns a per-pillar summary {seo, aeo, speed} (score + health_label + issue count) and a flat issues[] where each item = {code, category, severity, url, evidence, why, target_state, recommendation}.",
    inputSchema: {
      type: "object",
      properties: {
        site_url: { type: "string", description: "The site to audit, e.g. https://example.com" },
        max_pages: { type: "number", description: "Max pages to crawl from the sitemap (default 25, cap 100).", default: 25 },
        speed_sample: {
          type: "number",
          description:
            "How many pages to measure with PageSpeed Insights (homepage + representative pages). Default 3. Ignored unless PAGESPEED_API_KEY is set; HTML speed heuristics always run on every fetched page.",
          default: 3,
        },
      },
      required: ["site_url"],
    },
  },
  {
    name: "speed_audit",
    description:
      "READ-ONLY speed-only audit of ONE page. Always runs the HTML speed heuristics on the fetched page; when PAGESPEED_API_KEY is set it also runs Google PageSpeed Insights (mobile) for that page and returns Core Web Vitals (LCP, CLS, INP, TBT, TTFB) plus the top Lighthouse opportunities. Every finding carries category 'speed' and a 'how it should be' recommendation. Use audit_site for a whole-site, multi-pillar audit.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The exact page URL to measure, e.g. https://example.com/pricing" },
      },
      required: ["url"],
    },
  },
  {
    name: "propose_fixes",
    description:
      "READ-ONLY safe-fix ADVISOR for ONE page. Audits the page, then proposes a concrete, minimal fix for each issue: what to change, whether the change is VISIBLE or INVISIBLE to visitors, which issue code(s) it clears, and safety notes. Deterministic fixes carry an exact edit (inject viewport / Open Graph tags, decode HTML entities in the title, strip a leading heading emoji, rewrite http:// → https://, retag a heading that skips a level). Others are classified: 'needs-value' (alt text, dates, og:image — mechanical but a value must be supplied), 'manual' (a content/structure decision, guidance only), or 'infra' (server / robots.txt / sitemap / CDN / speed — not page markup). It NEVER writes anything. Pass any returned proposal to preview_fix to dry-run it before deciding.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The exact page URL to propose fixes for, e.g. https://example.com/pricing" },
        codes: {
          type: "array",
          items: { type: "string" },
          description: "Optional: only propose fixes for these issue codes (e.g. [\"missing_viewport\",\"title_html_entities\"]).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "preview_fix",
    description:
      "READ-ONLY dry-run of a single fix proposal (the object returned by propose_fixes) against the page's CURRENT HTML. Applies the edit statically — no rendering, no writing — and returns a regression-gate verdict: 'pass' (the edit is localized and touches only its intended region), 'idempotent' (already applied — a no-op), 'blocked' (the target is ambiguous or missing, so an automatic edit is unsafe), or 'manual' (needs a value, or lives in infrastructure). Includes the before/after of the affected region. This is a STRUCTURAL safety gate (does the edit stay in its region?), not a pixel/visual gate. NEVER modifies the site.",
    inputSchema: {
      type: "object",
      properties: {
        fix: {
          type: "object",
          description: "A fix proposal object exactly as returned in propose_fixes.proposals[]. Must include url and edit.",
        },
      },
      required: ["fix"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "audit_site": {
      const siteUrl = String(args.site_url ?? "").trim();
      if (!siteUrl) return fail("site_url is required.");
      const maxPages = typeof args.max_pages === "number" ? args.max_pages : 25;
      const speedSample = typeof args.speed_sample === "number" ? Math.max(0, Math.min(args.speed_sample, 25)) : 3;
      const result = await runAudit(siteUrl, { maxPages, speedSample });
      return ok(result);
    }

    case "speed_audit": {
      const url = String(args.url ?? "").trim();
      if (!url) return fail("url is required.");
      const normalized = normalizeSiteUrl(url);
      const res = await fetchText(normalized);
      const out: Record<string, unknown> = { url: normalized, pagespeed_enabled: pagespeedApiKey() !== "" };
      const rawIssues: Issue[] = [];

      if (res.status === 0) {
        rawIssues.push({ code: "fetch_failed", category: "seo", severity: "error", url: normalized, message: "Could not fetch the page (network error or timeout)." });
      } else {
        const page = parsePage(res.body, normalized, {
          statusCode: res.status,
          finalUrl: res.finalUrl,
          xRobotsTag: res.headers.get("x-robots-tag") || "",
        });
        // Heuristic speed checks only (the SEO/AEO checks belong to audit_site).
        rawIssues.push(...checkSpeedHeuristics(page));
      }

      const psi = await runPsi(normalized);
      if (psi) {
        out.core_web_vitals = psi.summary;
        rawIssues.push(...psi.issues);
      }

      const issues = rawIssues.map(enrichIssue);
      out.summary = speedPillarSummary(issues, psi ? [psi.summary] : []);
      out.issue_count = issues.length;
      out.issues = issues;
      return ok(out);
    }

    case "propose_fixes": {
      const url = String(args.url ?? "").trim();
      if (!url) return fail("url is required.");
      const filterCodes = Array.isArray(args.codes) ? (args.codes as unknown[]).map(String) : null;
      const normalized = normalizeSiteUrl(url);

      const res = await fetchPage(normalized);
      if (res.status === 0 && res.redirectChain.length === 0) return fail("Could not fetch the page (network error or timeout).");
      const page = parsePage(res.body, normalized, {
        statusCode: res.status,
        finalUrl: res.finalUrl,
        xRobotsTag: res.headers.get("x-robots-tag") || "",
      });
      page.redirectChain = res.redirectChain;

      let issues: Issue[] = checkPage(page);

      // On the homepage, also surface the light site-level files (llms.txt +
      // robots AI-bot block) so their fixes can be proposed too. We do NOT run
      // the full sitemap crawl here — propose_fixes is a single-page tool.
      let isHome = false;
      try {
        isHome = new URL(normalized).pathname === "/" || new URL(normalized).pathname === "";
      } catch {
        /* ignore */
      }
      if (isHome) {
        const origin = originOf(normalized);
        const llms = await fetchText(`${origin}/llms.txt`);
        issues.push(...checkLlmsTxt(normalized, llms.status, llms.status >= 200 && llms.status < 300 ? llms.body : null));
        const robots = await fetchText(`${origin}/robots.txt`);
        issues.push(...checkRobotsAiBots(normalized, robots.status, robots.status >= 200 && robots.status < 300 ? robots.body : null));
      }

      if (filterCodes) issues = issues.filter((i) => filterCodes.includes(i.code));

      const proposals = proposeFixes(issues, page);
      const byFamily: Record<string, number> = {};
      const byVisibility: Record<string, number> = {};
      for (const p of proposals) {
        byFamily[p.family] = (byFamily[p.family] ?? 0) + 1;
        byVisibility[p.visibility] = (byVisibility[p.visibility] ?? 0) + 1;
      }
      return ok({
        url: normalized,
        issue_count: issues.length,
        proposal_count: proposals.length,
        proposals_by_family: byFamily,
        proposals_by_visibility: byVisibility,
        note: "Read-only proposals. Pass any proposal to preview_fix to dry-run it. This server never writes to the site.",
        proposals,
      });
    }

    case "preview_fix": {
      const fix = args.fix as FixProposal | undefined;
      if (!fix || typeof fix !== "object" || !fix.url || !fix.edit) {
        return fail("fix is required and must be a proposal object from propose_fixes (with url + edit).");
      }
      const normalized = normalizeSiteUrl(String(fix.url));
      const res = await fetchText(normalized);
      if (res.status === 0) return fail("Could not fetch the page to preview against (network error or timeout).");
      const result = previewFix(fix, res.body);
      return ok(result);
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = new Server(
    { name: "seonix-seo-mcp", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await dispatch(name, (args ?? {}) as Record<string, unknown>);
    } catch (e) {
      // ToolError messages are safe/actionable; anything else is summarized.
      if (e instanceof ToolError) return fail(e.message);
      return fail(`Unexpected error in ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the MCP transport channel.
  process.stderr.write(`seonix-seo-mcp v${PKG_VERSION} ready on stdio\n`);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
