# Seonix SEO MCP

**A free, open-source [MCP](https://modelcontextprotocol.io) server that lets any AI agent audit ANY website for SEO, GEO/AEO, and speed problems — and tell you how it should be.**

Point Claude Desktop, Cursor, Cline, or any other MCP client at this server and ask it to *"audit https://example.com and tell me the top SEO and speed problems with how to fix each."* The agent crawls the site, runs the checks, and relays a plain-language report: what's wrong, why it matters, and the target state for each issue.

- **Platform-agnostic** — works on **any** site: WordPress, Shopify, custom, static, anything reachable over HTTP. No CMS assumptions.
- **Read-only — it reports, it does not fix.** The audit never modifies your site. It shows problems and gives CMS-neutral recommendations ("the page should have a unique `<title>` of 30–60 chars that includes the primary keyword"). **Whether and how to fix is your decision.**
- **Three pillars in one pass** — SEO, GEO/AEO (AI-search visibility), and **speed** (Core Web Vitals + performance).
- **AI-agnostic** — works with any MCP client. No vendor lock-in.
- **Free & open-source** — MIT licensed.
- **Dependency-light** — TypeScript, the official `@modelcontextprotocol/sdk`, and Node's built-in `fetch`. One runtime dependency.

The checks mirror the production [Seonix](https://seonix.ai) scanner — same issue codes, severities, and thresholds — and every finding carries a recommendation ported from the Seonix remediation catalog, rewritten to be platform-neutral.

> **Note on WordPress auto-fixers.** Earlier versions of this server shipped seven WordPress write tools (`wp_update_content`, `wp_set_media_alt`, `wp_set_yoast_meta`, …). They have been **moved out of the tool surface** into [`src/extras/wordpress-fixers.ts`](./src/extras/wordpress-fixers.ts) — kept for the record, but **not part of the server**. The auditor no longer needs any WordPress (or other) credentials to do its job.

---

## What it does

The auditor discovers pages from `sitemap.xml`, fetches each page's HTML, and reports problems across three pillars. The AI client summarizes the structured result for you.

### Tools

| Tool | Auth | What it does |
|------|------|--------------|
| `audit_site` | none (read-only) | Audit a whole site for **SEO + GEO/AEO + speed**. Discovers pages via `sitemap.xml`, fetches each page, runs all checks, and returns a per-pillar summary plus a flat `issues[]` where every item carries a recommendation. |
| `speed_audit` | none (read-only) | Speed-only audit of **one page**. Always runs the HTML speed heuristics; with a PageSpeed key it also returns Core Web Vitals + the top Lighthouse opportunities. |

Neither tool modifies anything.

### What `audit_site` checks

**SEO**

- **Title** — missing / > 60 / < 30 characters.
- **Meta description** — missing / > 160 / < 50 characters.
- **Headings** — missing H1 / multiple H1 / heading starts with an emoji / heading > 100 chars (likely a paragraph) / a heading before the first H1 / broken hierarchy (a skipped level).
- **Images** — empty/missing `alt` (with the offending `<img>` snippet as evidence).
- **Mixed content** — `http://` resources on an `https://` page.
- **Canonical** — canonical URL mismatch.
- **Viewport** — missing `<meta name="viewport">`.
- **Open Graph** — missing OG tags / missing `og:image`.

**GEO / AEO (AI-search visibility)**

- **JSON-LD** — `Article` `author` not a `Person` (resolves `@id` references so Yoast-style sites aren't false positives), `datePublished` missing, malformed or missing structured data.
- **AI-restrictive meta** — page opts out of AI engines via `nosnippet` / `noai` / `noimageai` (meta robots or `X-Robots-Tag`).
- **`/llms.txt`** — missing, or invalid (needs a `#` title + ≥ 1 Markdown link + ≥ 100 chars).
- **`robots.txt`** — blocks AI crawlers (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, OAI-SearchBot, anthropic-ai, ChatGPT-User, CCBot, Bytespider, Amazonbot, Applebot-Extended, meta-externalagent).

**Speed**

*Always on (every fetched page, no key needed) — HTML heuristics:*

- Render-blocking `<script>` (no `async`/`defer`) and `<link rel=stylesheet>` in `<head>`.
- `<img>` without `width`/`height` (layout-shift / CLS risk).
- Below-the-fold `<img>` without `loading="lazy"`.
- Very large inline `<style>`/`<script>` blocks.
- Heavy HTML document weight.
- Excessive DOM node count.

*When `PAGESPEED_API_KEY` is set — Google PageSpeed Insights (Lighthouse), on a small sample of pages:*

- Performance score + **Core Web Vitals** (LCP, CLS, INP, TBT, TTFB, FCP).
- Top Lighthouse opportunities mapped to issue codes: render-blocking resources, unused CSS, unused JavaScript, properly-size / efficiently-encode / next-gen images, offscreen images, text compression, slow server response (TTFB), excessive main-thread work, large DOM, short cache lifetime. Severity is banded by estimated time savings, mirroring the Seonix scanner.

### Output shape

`audit_site` returns:

```jsonc
{
  "site_url": "https://example.com",
  "pages_scanned": 25,
  "sitemap_source": "https://example.com/sitemap.xml",
  "speed": {
    "enabled_pagespeed": true,        // false when no PAGESPEED_API_KEY
    "pages_measured": 3,
    "measurements": [                  // one per PSI-sampled page
      { "url": "...", "strategy": "mobile", "performanceScore": 74,
        "lcpSeconds": 2.9, "cls": 0.04, "inpMs": 180, "tbtMs": 320, "ttfbMs": 410, "fcpSeconds": 1.8 }
    ]
  },
  "summary": {
    "seo":   { "score": 68, "health_label": "needs work", "issue_count": 8 },
    "aeo":   { "score": 94, "health_label": "good",        "issue_count": 3 },
    "speed": { "score": 82, "health_label": "good",        "issue_count": 7 }
  },
  "issue_count": 18,
  "issues_by_severity": { "error": 1, "warning": 9, "notice": 8 },
  "issues": [
    {
      "code": "title_too_long",
      "category": "seo",                       // "seo" | "aeo" | "speed"
      "severity": "warning",
      "url": "https://example.com/pricing",
      "evidence": { "length": 78, "title": "..." },
      "why": "Search engines typically display only about 60 characters of a title...",
      "target_state": "The <title> is 60 characters or fewer and leads with the important keywords.",
      "recommendation": "Shorten the <title> to 60 characters or fewer while keeping the primary keyword near the beginning..."
    }
    // ... every issue carries why / target_state / recommendation
  ]
}
```

- **`health_label`** is `good` (score ≥ 80), `needs work` (≥ 50), or `poor` (< 50).
- The **speed** pillar score is the median Lighthouse performance score across measured pages when PSI ran, otherwise a heuristic over the always-on speed checks.
- Page discovery reads `sitemap.xml` (polite, ~1 request/second, default 25 pages, max 100) and fetches each URL. **PSI is slow, so by default it only samples a few pages** (homepage + up to 3 representative pages); the always-on HTML heuristics run on every fetched page.

---

## Install

Requires **Node 18+** (uses global `fetch`).

```bash
git clone https://github.com/Effect-Agency/seonix-seo-mcp.git
cd seonix-seo-mcp
npm install
npm run build
```

This produces `dist/index.js` — the executable MCP server.

---

## Configuration

The auditor needs **no configuration** — it works on any public site out of the box.

| Variable | Required | Purpose |
|----------|----------|---------|
| `PAGESPEED_API_KEY` | optional | A [Google PageSpeed Insights API key](https://developers.google.com/speed/docs/insights/v5/get-started). When set, `audit_site` and `speed_audit` add Core Web Vitals + Lighthouse opportunities (sampled). Without it, the speed pillar runs on always-on HTML heuristics only. |

> Getting a key takes a minute (enable the *PageSpeed Insights API* in a Google Cloud project and create an API key). It is free for typical audit volumes. PSI calls are slow (10–30s each), which is why the audit samples only a few pages by default — tune the sample with the `speed_sample` argument.

---

## Add it to your AI client

Both clients launch the server with `node dist/index.js`. Use the **absolute path** to `dist/index.js`.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "seonix-seo": {
      "command": "node",
      "args": ["/absolute/path/to/seonix-seo-mcp/dist/index.js"],
      "env": {
        "PAGESPEED_API_KEY": "your-google-pagespeed-key"
      }
    }
  }
}
```

The `env` block is optional — omit it entirely to run with HTML speed heuristics only. Restart Claude Desktop after editing.

### Cursor

Edit `~/.cursor/mcp.json` (or **Cursor Settings → MCP → Add new server**):

```json
{
  "mcpServers": {
    "seonix-seo": {
      "command": "node",
      "args": ["/absolute/path/to/seonix-seo-mcp/dist/index.js"],
      "env": {
        "PAGESPEED_API_KEY": "your-google-pagespeed-key"
      }
    }
  }
}
```

The same `mcpServers` shape works for Cline, Continue, and most other MCP clients.

---

## Example prompts

Once connected, just talk to your agent:

- *"Audit https://example.com and tell me the top SEO and speed problems with how to fix each."*
- *"Run a full audit of my site and give me the per-pillar health (SEO, AEO, speed) plus the 10 most severe issues."*
- *"Check https://example.com for AI-search visibility — is anything blocking ChatGPT/Claude/Perplexity, and is the structured data in good shape?"*
- *"Speed-audit my pricing page and explain the Core Web Vitals and what's hurting them."*
- *"Crawl up to 50 pages of my site and list every page missing a meta description, with the recommended length."*

A typical flow the agent runs on its own:

1. `audit_site` → gets the per-pillar summary + a flat list of issues, each with `why` / `target_state` / `recommendation`.
2. It groups the issues (by pillar, by severity, or by page) and explains the highest-impact ones in plain language.
3. You decide what to change — the MCP never touches your site.

---

## How scoring works

- **SEO** and **AEO** pillar scores start at 100 and subtract weighted demerits per issue (error > warning > notice), floored at 0. This is a transparent heuristic so an AI client can relay a single number to a human — it is not the exact dashboard algorithm.
- **Speed** pillar score is the **median Lighthouse performance score** across the PSI-measured pages (the same basis Seonix uses for its speed pillar). When no PageSpeed key is configured, it falls back to the issue-based heuristic over the always-on speed checks.
- Every issue still carries its own `severity`, so you can rank by severity regardless of the rolled-up scores.

---

## Recommendations are platform-neutral

Recommendations live in [`src/recommendations.ts`](./src/recommendations.ts), ported from the Seonix remediation catalog but deliberately rewritten to be CMS-agnostic. You will never see "edit the Yoast field" or "change the WordPress block" — instead you get target states like *"the page should have a unique `<title>` of 30–60 chars that includes the primary keyword"* and imperative, vendor-neutral guidance that applies to any stack.

---

## Development

```bash
npm run build     # compile TypeScript → dist/
npm start         # run the built server on stdio
```

- `src/audit.ts` — all audit checks as pure, dependency-free functions over fetched HTML (SEO + AEO + speed heuristics) and the PageSpeed-Insights parsing/mapping. Easy to unit test.
- `src/recommendations.ts` — the platform-neutral recommendation catalog (issue code → `why` / `target_state` / `recommendation`).
- `src/index.ts` — the MCP server: `ListTools` + `CallTool`, sitemap discovery, page fetching, PSI sampling, and result assembly.
- `src/extras/wordpress-fixers.ts` — the **archived** WordPress write tools. Not imported by the server; kept for the record.

### Smoke test (JSON-RPC over stdio)

You can drive the server directly:

```bash
npm run build
# initialize → tools/list → tools/call audit_site, piped over stdin
```

(see the round-trip example in the project history — `audit_site` returns issues with recommendations and a speed section even without a PageSpeed key).

---

## License

[MIT](./LICENSE). Free to use, modify, and distribute.
