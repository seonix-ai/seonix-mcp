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
  checkLlmsTxt,
  checkPage,
  checkRobotsAiBots,
  checkSpeedHeuristics,
  parsePage,
  parsePsiResponse,
  psiToIssues,
  type Issue,
  type IssueCategory,
  type PsiApiResponse,
  type PsiSummary,
} from "./audit.js";
import { recommendationFor } from "./recommendations.js";

const PKG_VERSION = "2.0.0";
const USER_AGENT = `seonix-seo-mcp/${PKG_VERSION} (+https://github.com/Effect-Agency/seonix-seo-mcp)`;

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
// Sitemap discovery
// ---------------------------------------------------------------------------

/**
 * Discover up to `cap` page URLs for a site, politely.
 *
 * Strategy: read /sitemap.xml (and sitemap_index.xml). Sitemap indexes are
 * followed one level deep into child sitemaps. We extract <loc> values and
 * cap the total. Falls back to just the homepage if nothing is found.
 */
async function discoverUrls(siteUrl: string, cap: number): Promise<{ urls: string[]; source: string }> {
  const origin = originOf(siteUrl);
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];

  const collected = new Set<string>();
  let source = "homepage-fallback";

  for (const sm of candidates) {
    const res = await fetchText(sm);
    if (res.status < 200 || res.status >= 300 || !res.body.includes("<")) continue;
    source = sm;

    const locs = extractLocs(res.body);
    const childSitemaps = res.body.includes("<sitemapindex") ? locs.filter((l) => /\.xml(\.gz)?($|\?)/i.test(l)) : [];

    if (childSitemaps.length > 0) {
      // Sitemap index — descend one level, politely (~1 req/sec).
      for (const child of childSitemaps) {
        if (collected.size >= cap) break;
        await sleep(1000);
        const c = await fetchText(child);
        if (c.status < 200 || c.status >= 300) continue;
        for (const loc of extractLocs(c.body)) {
          if (/\.xml(\.gz)?($|\?)/i.test(loc)) continue; // skip nested sitemaps
          if (collected.size >= cap) break;
          collected.add(loc);
        }
      }
    } else {
      for (const loc of locs) {
        if (collected.size >= cap) break;
        collected.add(loc);
      }
    }
    if (collected.size > 0) break;
  }

  if (collected.size === 0) {
    return { urls: [origin + "/"], source };
  }
  return { urls: [...collected].slice(0, cap), source };
}

/** Extract <loc>…</loc> values from a sitemap XML body. */
function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].trim());
  }
  return out;
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

  const { urls, source } = await discoverUrls(siteUrl, cap);

  const rawIssues: Issue[] = [];

  // Polite, sequential page fetches (~1 req/sec) — this is a read-only audit
  // against a stranger's site; we do not hammer it. HTML checks (SEO + AEO +
  // always-on speed heuristics) run on every fetched page.
  for (let i = 0; i < urls.length; i++) {
    if (i > 0) await sleep(1000);
    const url = urls[i];
    const res = await fetchText(url);
    if (res.status === 0) {
      rawIssues.push({ code: "fetch_failed", category: "seo", severity: "error", url, message: "Could not fetch the page (network error or timeout)." });
      continue;
    }
    const page = parsePage(res.body, url, {
      statusCode: res.status,
      finalUrl: res.finalUrl,
      xRobotsTag: res.headers.get("x-robots-tag") || "",
    });
    rawIssues.push(...checkPage(page));
  }

  // Site-level checks: /llms.txt and /robots.txt (one fetch each).
  const llms = await fetchText(`${originOf(siteUrl)}/llms.txt`);
  rawIssues.push(...checkLlmsTxt(siteUrl, llms.status, llms.status >= 200 && llms.status < 300 ? llms.body : null));

  const robots = await fetchText(`${originOf(siteUrl)}/robots.txt`);
  rawIssues.push(...checkRobotsAiBots(siteUrl, robots.status, robots.status >= 200 && robots.status < 300 ? robots.body : null));

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
      "READ-ONLY, platform-agnostic site auditor. Works on ANY website (WordPress, Shopify, custom, static — anything). Audits SEO, GEO/AEO and speed: it SHOWS problems and gives CMS-neutral 'how it should be' recommendations — it does NOT modify the site; you decide whether/how to fix. Discovers pages via sitemap.xml (polite ~1 req/sec, default 25 / max 100 pages), fetches each page's HTML, and runs: title/meta-description length, image alt text, H1 count, emoji/overlong/before-H1/broken-hierarchy headings, mixed content, JSON-LD Article author/dates + structured-data validity, AI-restrictive meta robots, /llms.txt, robots.txt AI-bot blocking, canonical, viewport, Open Graph — PLUS always-on speed heuristics (render-blocking head resources, images missing width/height, un-lazy offscreen images, large inline blocks, page weight, DOM size). When PAGESPEED_API_KEY is set, it also runs Google PageSpeed Insights (Core Web Vitals + Lighthouse opportunities) on a small sample of pages. Returns a per-pillar summary {seo, aeo, speed} (score + health_label + issue count) and a flat issues[] where each item = {code, category, severity, url, evidence, why, target_state, recommendation}.",
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
