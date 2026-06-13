/**
 * audit.ts — pure, testable SEO / GEO / AEO checks over fetched HTML.
 *
 * These mirror the production Seonix scanner (`backend/internal/scanner/`):
 * the same issue codes, severities and thresholds, so an audit here reads the
 * same as an audit in the dashboard. Everything in this file is dependency-free
 * (no DOM library) so it runs anywhere Node 18+ runs and is trivial to unit test.
 *
 * The two entry points are:
 *   - parsePage(html, url)         → a structured PageData snapshot
 *   - checkPage(page) / checkSite  → Issue[]  (the audit verdict)
 *
 * Every check is a small pure function taking PageData and returning Issue[],
 * so callers (and tests) can run them individually.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "notice";

/** Pillar an issue rolls up to. */
export type IssueCategory = "seo" | "aeo" | "speed";

/** A single SEO/GEO/AEO/speed finding. Shape matches the scanner's contract. */
export interface Issue {
  code: string;
  /** Pillar this issue belongs to. Defaults are assigned via the recommendation catalog. */
  category?: IssueCategory;
  severity: Severity;
  url: string;
  /** Human-readable, English. Safe to show to an end user. */
  message: string;
  /** Machine-readable supporting detail (counts, offending snippets, etc.). */
  evidence?: Record<string, unknown>;
}

export interface HeadingInfo {
  level: number; // 1..6
  text: string;
}

export interface ImageEvidence {
  src: string;
  outerHTML: string;
}

/** Structured snapshot of a single fetched page. */
export interface PageData {
  url: string;
  finalUrl: string;
  statusCode: number;
  isHttps: boolean;

  title: string;
  hasTitle: boolean;
  metaDescription: string;
  hasMetaDescription: boolean;

  canonicalUrl: string;
  robotsDirectives: string;
  xRobotsTag: string;

  hasViewport: boolean;

  h1Tags: string[];
  headings: HeadingInfo[];

  imagesTotal: number;
  imagesWithoutAlt: ImageEvidence[];

  mixedContentUrls: string[];

  // Open Graph
  hasOgTitle: boolean;
  hasOgDescription: boolean;
  hasOgUrl: boolean;
  ogImage: string;
  hasTwitterCard: boolean;

  // Raw JSON-LD blocks (strings) found on the page.
  jsonLd: string[];

  // --- Speed heuristics (parsed from the same HTML, no PSI key needed) ---
  /** Render-blocking <script> in <head> with no async/defer/module/json. */
  blockingScriptsInHead: number;
  /** <link rel="stylesheet"> in <head> loaded synchronously (no media=print swap). */
  blockingStylesheetsInHead: number;
  /** Total <img> count on the page. */
  imgCount: number;
  /** <img> with neither width nor height (nor a CSS aspect-ratio hint) — CLS risk. */
  imagesWithoutDimensions: number;
  /** <img> beyond the first few that do NOT set loading="lazy". */
  offscreenImagesNotLazy: number;
  /** Largest single inline <style> or <script> block, in bytes. */
  largestInlineBytes: number;
  /** Sum of all inline <style> + <script> block bytes. */
  totalInlineBytes: number;
  /** Rough size of the fetched HTML document, in bytes. */
  htmlBytes: number;
  /** Rough count of HTML element open-tags (DOM node estimate). */
  domNodeCount: number;
}

// ---------------------------------------------------------------------------
// HTML parsing helpers (regex/string-based — no DOM dependency)
// ---------------------------------------------------------------------------

/** Decode the small set of HTML entities that show up in titles/descriptions. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&#x0*27;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_m, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    });
}

/** Strip all HTML tags from a fragment and collapse whitespace. */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Return the content of the <head>…</head> region, or the whole doc as fallback. */
function headRegion(html: string): string {
  const m = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  return m ? m[1] : html;
}

/** Read one attribute's value from a single tag string. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
}

/** Does the tag carry the attribute at all (even empty, e.g. alt="")? */
function hasAttr(tag: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, "i").test(tag);
}

/** Find a <meta> tag whose `name`/`property` matches and return its content. */
function metaContent(html: string, keys: string[]): string | null {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    const key = (attr(tag, "name") || attr(tag, "property") || attr(tag, "http-equiv") || "").toLowerCase();
    if (keys.includes(key)) {
      const content = attr(tag, "content");
      if (content !== null) return content;
    }
  }
  return null;
}

function metaExists(html: string, keys: string[]): boolean {
  return metaContent(html, keys) !== null;
}

/** Extract all headings H1–H6 in document order. */
export function extractHeadings(html: string): HeadingInfo[] {
  const out: HeadingInfo[] = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ level: Number(m[1]), text: stripTags(m[2]) });
  }
  return out;
}

/** Extract all <img> tags (raw) from the document. */
function extractImgTags(html: string): string[] {
  return html.match(/<img\b[^>]*\/?>/gi) || [];
}

/** Resolve a possibly-relative URL against a base; return the input on failure. */
export function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/**
 * Build a PageData snapshot from fetched HTML.
 *
 * `statusCode`/`finalUrl` come from the HTTP response; `xRobotsTag` from the
 * `X-Robots-Tag` response header (optional). The rest is parsed from the body.
 */
export function parsePage(
  html: string,
  url: string,
  opts: { statusCode?: number; finalUrl?: string; xRobotsTag?: string } = {},
): PageData {
  const statusCode = opts.statusCode ?? 200;
  const finalUrl = opts.finalUrl ?? url;
  const isHttps = (() => {
    try {
      return new URL(finalUrl).protocol === "https:";
    } catch {
      return finalUrl.startsWith("https:");
    }
  })();

  const head = headRegion(html);

  // <title>
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const hasTitle = titleMatch !== null;
  const title = titleMatch ? stripTags(titleMatch[1]) : "";

  // meta description
  const md = metaContent(html, ["description"]);
  const hasMetaDescription = md !== null;
  const metaDescription = (md ?? "").trim();

  // canonical
  let canonicalUrl = "";
  for (const link of html.match(/<link\b[^>]*>/gi) || []) {
    if ((attr(link, "rel") || "").toLowerCase() === "canonical") {
      canonicalUrl = (attr(link, "href") || "").trim();
      break;
    }
  }

  // robots directives (meta robots) + X-Robots-Tag header
  const robotsDirectives = (metaContent(html, ["robots"]) || "").trim();
  const xRobotsTag = (opts.xRobotsTag || "").trim();

  // viewport
  const hasViewport = metaExists(html, ["viewport"]);

  // headings
  const headings = extractHeadings(html);
  const h1Tags = headings.filter((h) => h.level === 1).map((h) => h.text);

  // images
  const imgTags = extractImgTags(html);
  const imagesTotal = imgTags.length;
  const imagesWithoutAlt: ImageEvidence[] = [];
  for (const tag of imgTags) {
    const altVal = attr(tag, "alt");
    // Scanner contract: alt="" and missing alt are BOTH treated as missing.
    // role="presentation" / aria-hidden are intentionally NOT honored.
    if (altVal === null || altVal.trim() === "") {
      const src = attr(tag, "src") || attr(tag, "data-src") || "";
      imagesWithoutAlt.push({ src: resolveUrl(src, finalUrl), outerHTML: tag });
    }
  }

  // mixed content: http:// resources in src/href/srcset on an https page
  const mixedContentUrls = isHttps ? findMixedContent(html) : [];

  // Open Graph + Twitter
  const hasOgTitle = nonEmpty(metaContent(html, ["og:title"]));
  const hasOgDescription = nonEmpty(metaContent(html, ["og:description"]));
  const hasOgUrl = nonEmpty(metaContent(html, ["og:url"]));
  const ogImage = (metaContent(html, ["og:image"]) || "").trim();
  const hasTwitterCard = nonEmpty(metaContent(html, ["twitter:card"]));

  // JSON-LD
  const jsonLd = extractJsonLd(html);

  // Speed heuristics (cheap, parsed from the same HTML).
  const speed = parseSpeedHeuristics(html, head, imgTags);

  return {
    url,
    finalUrl,
    statusCode,
    isHttps,
    title,
    hasTitle,
    metaDescription,
    hasMetaDescription,
    canonicalUrl,
    robotsDirectives,
    xRobotsTag,
    hasViewport,
    h1Tags,
    headings,
    imagesTotal,
    imagesWithoutAlt,
    mixedContentUrls,
    hasOgTitle,
    hasOgDescription,
    hasOgUrl,
    ogImage,
    hasTwitterCard,
    jsonLd,
    ...speed,
  };
}

// ---------------------------------------------------------------------------
// Speed heuristics parsing (no PageSpeed API key required)
// ---------------------------------------------------------------------------

/** How many leading images are assumed "above the fold" and exempt from the lazy-load check. */
const ABOVE_THE_FOLD_IMAGES = 3;

interface SpeedHeuristics {
  blockingScriptsInHead: number;
  blockingStylesheetsInHead: number;
  imgCount: number;
  imagesWithoutDimensions: number;
  offscreenImagesNotLazy: number;
  largestInlineBytes: number;
  totalInlineBytes: number;
  htmlBytes: number;
  domNodeCount: number;
}

/**
 * Parse the cheap, always-on speed signals out of the already-fetched HTML.
 * These are deliberately conservative heuristics — they never replace a real
 * Lighthouse run, they give a baseline when no PSI key is configured.
 */
export function parseSpeedHeuristics(html: string, head: string, imgTags: string[]): SpeedHeuristics {
  // Render-blocking <script> in <head>: a classic blocking script has no
  // async / defer, and is not a module or a JSON/data block.
  let blockingScriptsInHead = 0;
  for (const tag of head.match(/<script\b[^>]*>/gi) || []) {
    if (hasAttr(tag, "async") || hasAttr(tag, "defer")) continue;
    const type = (attr(tag, "type") || "").toLowerCase();
    if (type === "module") continue; // modules are deferred by spec
    if (type && type !== "text/javascript" && type !== "application/javascript") continue; // ld+json, importmap, etc.
    if (attr(tag, "src") === null) continue; // inline handled separately
    blockingScriptsInHead++;
  }

  // Render-blocking stylesheets in <head>: <link rel="stylesheet"> loaded
  // synchronously. A print/onload media-swap is non-blocking.
  let blockingStylesheetsInHead = 0;
  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    if ((attr(tag, "rel") || "").toLowerCase() !== "stylesheet") continue;
    const media = (attr(tag, "media") || "").toLowerCase();
    if (media === "print") continue; // common "load CSS async" trick
    blockingStylesheetsInHead++;
  }

  // Images: missing dimensions (CLS risk) + offscreen-without-lazy.
  let imagesWithoutDimensions = 0;
  let offscreenImagesNotLazy = 0;
  imgTags.forEach((tag, idx) => {
    const hasW = attr(tag, "width") !== null;
    const hasH = attr(tag, "height") !== null;
    const style = (attr(tag, "style") || "").toLowerCase();
    const hasAspect = /aspect-ratio\s*:/.test(style) || (/width\s*:/.test(style) && /height\s*:/.test(style));
    if (!(hasW && hasH) && !hasAspect) imagesWithoutDimensions++;

    if (idx >= ABOVE_THE_FOLD_IMAGES) {
      const loading = (attr(tag, "loading") || "").toLowerCase();
      if (loading !== "lazy") offscreenImagesNotLazy++;
    }
  });

  // Inline <style> / <script> block sizes (bytes of their text content).
  let largestInlineBytes = 0;
  let totalInlineBytes = 0;
  const inlineRe = /<(style|script)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(html)) !== null) {
    const openAttrs = m[2];
    // A <script src="…"> is external — its (usually empty) body is not "inline".
    if (m[1].toLowerCase() === "script" && /\bsrc\s*=/.test(openAttrs)) continue;
    const bytes = byteLength(m[3]);
    totalInlineBytes += bytes;
    if (bytes > largestInlineBytes) largestInlineBytes = bytes;
  }

  // Rough DOM node count: number of element open-tags (excludes comments,
  // closing tags, void-tag duplicates). Good enough to flag a runaway DOM.
  const domNodeCount = (html.match(/<[a-zA-Z][^>]*?>/g) || []).length;

  return {
    blockingScriptsInHead,
    blockingStylesheetsInHead,
    imgCount: imgTags.length,
    imagesWithoutDimensions,
    offscreenImagesNotLazy,
    largestInlineBytes,
    totalInlineBytes,
    htmlBytes: byteLength(html),
    domNodeCount,
  };
}

/** UTF-8 byte length of a string (Node 18+ has TextEncoder globally). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function nonEmpty(s: string | null): boolean {
  return s !== null && s.trim() !== "";
}

/** Find http:// resource references (src/href/srcset) — mixed content on https. */
export function findMixedContent(html: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:src|href|srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    // srcset can hold multiple comma-separated candidates.
    for (const part of val.split(",")) {
      const u = part.trim().split(/\s+/)[0];
      if (/^http:\/\//i.test(u)) out.add(u);
    }
  }
  return [...out];
}

/** Extract the raw text of every <script type="application/ld+json"> block. */
export function extractJsonLd(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type\s*=\s*("|')application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[2].trim();
    if (body) out.push(body);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emoji detection (mirrors scanner/analyzer/heading_quality.go isLeadingEmoji)
// ---------------------------------------------------------------------------

/** True when the codepoint is an emoji-like symbol per the scanner's ranges. */
export function isLeadingEmoji(cp: number): boolean {
  return (
    (cp >= 0x1f000 && cp <= 0x1f02f) || // mahjong
    (cp >= 0x1f100 && cp <= 0x1f1ff) || // enclosed alphanumerics / regional indicators
    (cp >= 0x1f300 && cp <= 0x1faff) || // misc symbols & pictographs (+ extensions)
    (cp >= 0x2300 && cp <= 0x23ff) || // misc technical (⌚ ⏰)
    (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols + dingbats (☕ ⭐ ✅ ❌)
    (cp >= 0x2b00 && cp <= 0x2bff) // misc symbols & arrows (⭐ ⬆ ⬇)
  );
}

const VARIATION_SELECTOR = 0xfe0f;

/** Codepoint of the first non-whitespace character of s, or null. */
function firstCodepoint(s: string): number | null {
  const trimmed = s.trimStart();
  if (trimmed === "") return null;
  return trimmed.codePointAt(0) ?? null;
}

// ---------------------------------------------------------------------------
// Heading "too long / likely paragraph" helpers (mirror heading_quality.go)
// ---------------------------------------------------------------------------

const HEADING_MAX_CHARS = 100;

const HEADING_ABBREVIATIONS = [
  "z. B.", "z.B.", "bzw.", "usw.", "etc.",
  "e.g.", "i.e.", "Mr.", "Mrs.", "Dr.",
  "vs.", "St.", "Nr.", "ca.", "u. a.",
];

const RE_DECIMAL = /\d+\.\d+/g;
const RE_URL_TLD = /\b\w+\.(?:com|net|org|io|ai|de|co|uk|eu|ru|app|dev|info|biz|me|tv)\b/gi;
const RE_SENTENCE_TERMINATOR = /[.!?](?:\s+\p{Lu}|\s*$)/gu;

/** Count rune length (codepoints), matching Go's utf8.RuneCountInString. */
function runeLength(s: string): number {
  return [...s].length;
}

// ---------------------------------------------------------------------------
// Tiny JSON-LD flattener for the AEO Article/author/date checks
// ---------------------------------------------------------------------------

interface SchemaNode {
  types: string[];
  raw: Record<string, unknown>;
}

const ARTICLE_TYPES = new Set([
  "Article",
  "NewsArticle",
  "BlogPosting",
  "TechArticle",
  "ScholarlyArticle",
  "Report",
]);

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

/** Walk a parsed JSON-LD value, collecting every object that has an @type. */
function collectNodes(value: unknown, out: SchemaNode[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const types = typesOf(obj);
    if (types.length > 0) out.push({ types, raw: obj });
    // Recurse into @graph and nested objects/arrays.
    for (const key of Object.keys(obj)) {
      if (key === "@type") continue;
      collectNodes(obj[key], out);
    }
  }
}

/** Parse all JSON-LD blocks into flattened typed nodes. Malformed blocks skip. */
function parseSchemaNodes(blocks: string[]): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (const block of blocks) {
    try {
      collectNodes(JSON.parse(block), out);
    } catch {
      // Malformed JSON-LD is reported by jsonld_invalid, not here.
    }
  }
  return out;
}

function isArticleLike(n: SchemaNode): boolean {
  return n.types.some((t) => ARTICLE_TYPES.has(t));
}

// ---------------------------------------------------------------------------
// Per-page checks
// ---------------------------------------------------------------------------

export function checkTitle(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const title = p.title.trim();
  if (!p.hasTitle || title === "") {
    return [{ code: "title_missing", severity: "warning", url: p.url, message: "Page has no <title> tag." }];
  }
  const len = runeLength(title);
  const issues: Issue[] = [];
  if (len > 60) {
    issues.push({
      code: "title_too_long",
      severity: "warning",
      url: p.url,
      message: `Title is ${len} characters (recommended ≤ 60).`,
      evidence: { length: len, title },
    });
  }
  if (len < 30) {
    issues.push({
      code: "title_too_short",
      severity: "warning",
      url: p.url,
      message: `Title is ${len} characters (recommended ≥ 30).`,
      evidence: { length: len, title },
    });
  }
  return issues;
}

export function checkMetaDescription(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const desc = p.metaDescription.trim();
  if (!p.hasMetaDescription || desc === "") {
    return [
      {
        code: "meta_description_missing",
        severity: "error",
        url: p.url,
        message: "Page has no meta description.",
      },
    ];
  }
  const len = runeLength(desc);
  const issues: Issue[] = [];
  if (len > 160) {
    issues.push({
      code: "meta_desc_too_long",
      severity: "warning",
      url: p.url,
      message: `Meta description is ${len} characters (recommended ≤ 160).`,
      evidence: { length: len, description: desc },
    });
  }
  if (len < 50) {
    issues.push({
      code: "meta_desc_too_short",
      severity: "warning",
      url: p.url,
      message: `Meta description is ${len} characters (recommended ≥ 50).`,
      evidence: { length: len, description: desc },
    });
  }
  return issues;
}

export function checkH1(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  if (p.h1Tags.length === 0) {
    return [
      {
        code: "h1_missing",
        severity: "warning",
        url: p.url,
        message: "Page has no H1 heading.",
        evidence: { heading_outline: outline(p.headings) },
      },
    ];
  }
  if (p.h1Tags.length > 1) {
    return [
      {
        code: "h1_multiple",
        severity: "warning",
        url: p.url,
        message: `Page has ${p.h1Tags.length} H1 headings — it should have exactly one.`,
        evidence: { count: p.h1Tags.length, h1_tags: p.h1Tags },
      },
    ];
  }
  return [];
}

export function checkImages(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  if (p.imagesWithoutAlt.length === 0) return [];
  return [
    {
      code: "images_missing_alt",
      severity: "warning",
      url: p.url,
      message: `${p.imagesWithoutAlt.length} of ${p.imagesTotal} image(s) have an empty or missing alt attribute.`,
      evidence: {
        images_without_alt: p.imagesWithoutAlt.length,
        images_total: p.imagesTotal,
        // First 20 offending tags so the agent can locate them in block content.
        examples: p.imagesWithoutAlt.slice(0, 20).map((e) => ({ src: e.src, outer_html: e.outerHTML })),
      },
    },
  ];
}

export function checkHeadingEmoji(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const issues: Issue[] = [];
  for (const h of p.headings) {
    const cp = firstCodepoint(h.text);
    if (cp === null) continue;
    if (cp === VARIATION_SELECTOR || isLeadingEmoji(cp)) {
      issues.push({
        code: "heading_emoji",
        severity: "notice",
        url: p.url,
        message: `H${h.level} heading starts with an emoji: "${h.text.trim().slice(0, 60)}".`,
        evidence: { heading_level: h.level, heading_text: h.text, leading_emoji: String.fromCodePoint(cp) },
      });
    }
  }
  return issues;
}

export function checkHeadingTooLong(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const issues: Issue[] = [];
  for (const h of p.headings) {
    const text = h.text.trim();
    if (text === "") continue;
    const reasons: string[] = [];
    const len = runeLength(text);
    if (len > HEADING_MAX_CHARS) reasons.push("length");

    let scratch = text;
    for (const abbr of HEADING_ABBREVIATIONS) scratch = scratch.split(abbr).join("");
    scratch = scratch.replace(RE_DECIMAL, "").replace(RE_URL_TLD, "");
    const matches = scratch.match(RE_SENTENCE_TERMINATOR) || [];
    if (matches.length >= 2) reasons.push("multiple_sentences");

    if (reasons.length === 0) continue;
    issues.push({
      code: "heading_too_long_likely_paragraph",
      severity: "notice",
      url: p.url,
      message: `H${h.level} heading looks like a paragraph (${reasons.join(", ")}).`,
      evidence: { heading_level: h.level, heading_text: h.text, char_count: len, reasons },
    });
  }
  return issues;
}

export function checkHeadingHierarchy(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  if (p.headings.length < 2) return [];
  for (let i = 1; i < p.headings.length; i++) {
    const prev = p.headings[i - 1].level;
    const curr = p.headings[i].level;
    if (curr > prev + 1) {
      return [
        {
          code: "broken_heading_hierarchy",
          severity: "notice",
          url: p.url,
          message: `Heading level jumps from H${prev} to H${curr} (H${prev + 1} is skipped).`,
          evidence: {
            expected_level: prev + 1,
            actual_level: curr,
            after_heading: p.headings[i - 1].text,
            heading_outline: outline(p.headings),
          },
        },
      ];
    }
  }
  return [];
}

export function checkHeadingBeforeH1(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  if (p.headings.length === 0) return [];
  let firstH1 = -1;
  const pre: { level: number; text: string }[] = [];
  for (let i = 0; i < p.headings.length; i++) {
    if (p.headings[i].level === 1) {
      firstH1 = i;
      break;
    }
    pre.push({ level: p.headings[i].level, text: p.headings[i].text });
  }
  if (firstH1 < 0 || pre.length === 0) return [];
  return [
    {
      code: "heading_before_h1",
      severity: "warning",
      url: p.url,
      message: `${pre.length} heading(s) appear before the first H1.`,
      evidence: { first_h1_index: firstH1, pre_h1_headings: pre, heading_outline: outline(p.headings) },
    },
  ];
}

export function checkMixedContent(p: PageData): Issue[] {
  if (!p.isHttps || p.mixedContentUrls.length === 0) return [];
  return [
    {
      code: "ssl_mixed_content",
      severity: "warning",
      url: p.url,
      message: `${p.mixedContentUrls.length} resource(s) loaded over http:// on an https page.`,
      evidence: { mixed_content_count: p.mixedContentUrls.length, examples: p.mixedContentUrls.slice(0, 5) },
    },
  ];
}

export function checkCanonical(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const canonical = p.canonicalUrl.trim();
  if (canonical === "") return [];
  const norm = (s: string) => s.replace(/\/+$/, "");
  if (norm(canonical) !== norm(p.url) && norm(canonical) !== norm(p.finalUrl)) {
    return [
      {
        code: "canonical_mismatch",
        severity: "warning",
        url: p.url,
        message: `Canonical URL (${canonical}) does not match the page URL.`,
        evidence: { canonical_url: canonical, final_url: p.finalUrl },
      },
    ];
  }
  return [];
}

export function checkViewport(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  if (p.hasViewport) return [];
  return [
    { code: "missing_viewport", severity: "warning", url: p.url, message: "Page is missing the viewport meta tag (mobile rendering)." },
  ];
}

export function checkOpenGraph(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const hasAny = p.hasOgTitle || p.hasOgDescription || p.hasOgUrl || p.ogImage !== "";
  if (!hasAny) {
    return [
      {
        code: "missing_og_tags",
        severity: "notice",
        url: p.url,
        message: "Page has no Open Graph tags (link previews on social / chat).",
        evidence: ogSnapshot(p),
      },
    ];
  }
  if (p.ogImage === "") {
    return [
      {
        code: "og_image_missing",
        severity: "notice",
        url: p.url,
        message: "Open Graph tags present but og:image is missing.",
        evidence: ogSnapshot(p),
      },
    ];
  }
  return [];
}

function ogSnapshot(p: PageData): Record<string, unknown> {
  return {
    og_title: p.hasOgTitle,
    og_description: p.hasOgDescription,
    og_url: p.hasOgUrl,
    og_image: p.ogImage !== "",
    twitter_card: p.hasTwitterCard,
  };
}

export function checkStructuredData(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  if (p.jsonLd.length === 0) {
    return [
      { code: "missing_structured_data", severity: "notice", url: p.url, message: "Page has no JSON-LD structured data." },
    ];
  }
  for (const block of p.jsonLd) {
    try {
      JSON.parse(block);
    } catch (e) {
      return [
        {
          code: "invalid_structured_data",
          severity: "warning",
          url: p.url,
          message: "Page has a malformed JSON-LD block.",
          evidence: { error: String(e), jsonld_block: block.slice(0, 600) },
        },
      ];
    }
  }
  return [];
}

/** AEO: Article author must be a Person, and datePublished/dateModified present. */
export function checkAeoArticleSchema(p: PageData): Issue[] {
  if (!okStatus(p) || p.jsonLd.length === 0) return [];
  const nodes = parseSchemaNodes(p.jsonLd);
  if (nodes.length === 0) return [];
  const issues: Issue[] = [];

  for (const n of nodes) {
    if (!isArticleLike(n)) continue;

    // author must be a Person. IMPORTANT: Yoast and most SEO plugins emit the
    // author as an @id *reference* to a separate Person node in the @graph —
    // the inline author object carries `{ name, @id }` but NO @type. So we must
    // resolve the @id against the other nodes before deciding, otherwise every
    // Yoast site is a false positive. (The legacy string-author shorthand
    // `"author": "Jane Doe"` is tolerated — it carries no @type but isn't an
    // obvious Organization.)
    const author = n.raw["author"];
    if (author !== undefined && author && typeof author === "object" && !Array.isArray(author)) {
      const a = author as Record<string, unknown>;
      const directTypes = typesOf(a);
      const name = typeof a["name"] === "string" ? (a["name"] as string).trim() : "";
      const refId = typeof a["@id"] === "string" ? (a["@id"] as string).trim() : "";
      let resolvedPerson = false;
      if (refId) {
        const ref = nodes.find(
          (nn) => typeof nn.raw["@id"] === "string" && (nn.raw["@id"] as string) === refId,
        );
        if (ref && ref.types.includes("Person")) resolvedPerson = true;
      }
      const isPerson = directTypes.includes("Person") || resolvedPerson;
      if (!isPerson) {
        const isEmpty = name === "" && refId === "";
        issues.push({
          code: "aeo_jsonld_author_not_person",
          severity: "notice",
          url: p.url,
          message: isEmpty
            ? "Article JSON-LD has an empty author (often caused by post_author=0 in WordPress)."
            : `Article JSON-LD author is "${directTypes[0] || "(untyped/unresolved reference)"}", not a Person.`,
          evidence: { author_type: directTypes[0] || "(untyped)", author_name: name, author_ref: refId },
        });
      }
    }

    // datePublished is the date that matters for freshness signals. A missing
    // dateModified alone is NOT an error (it just means the post was never
    // modified after publishing), so we only flag a missing datePublished.
    if (n.raw["datePublished"] === undefined) {
      issues.push({
        code: "aeo_jsonld_dates_missing",
        severity: "notice",
        url: p.url,
        message: "Article JSON-LD is missing datePublished.",
        evidence: { missing_fields: ["datePublished"] },
      });
    }
  }
  return dedupeByCode(issues);
}

/** AEO: page opts out of AI engines via nosnippet / noai / noimageai. */
export function checkAeoMetaTags(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const directives = ["nosnippet", "noai", "noimageai"];
  const combined = (p.robotsDirectives + " " + p.xRobotsTag).toLowerCase();
  const tokens = new Set(combined.split(/[,;\s]+/).filter(Boolean));
  const hits = directives.filter((d) => tokens.has(d));
  if (hits.length === 0) return [];
  return [
    {
      code: "aeo_ai_meta_tag_restrictive",
      severity: "warning",
      url: p.url,
      message: `Page sets AI-restrictive directive(s): ${hits.join(", ")}. AI engines will not cite it.`,
      evidence: { directives: hits },
    },
  ];
}

// ---------------------------------------------------------------------------
// Speed checks — HTML heuristics (always on, no PageSpeed API key needed)
// ---------------------------------------------------------------------------

// Heuristic thresholds. Conservative on purpose: a finding should reflect a
// plausible real slowdown, not nitpick a fast page.
const HEURISTIC_BLOCKING_HEAD_RESOURCES = 4; // combined blocking scripts + stylesheets in <head>
const HEURISTIC_LARGE_INLINE_BYTES = 50 * 1024; // a single inline <style>/<script> over ~50 KB
const HEURISTIC_HEAVY_HTML_BYTES = 250 * 1024; // HTML document over ~250 KB
const HEURISTIC_LARGE_DOM_NODES = 1500; // Lighthouse warns ~1,500, errors ~3,000

/**
 * Speed findings derived purely from the fetched HTML. Each carries category
 * "speed" and mirrors the recommendation shape of the SEO/AEO checks. These
 * run on EVERY fetched page (PSI, which is slow, only samples a few).
 */
export function checkSpeedHeuristics(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const issues: Issue[] = [];

  const blockingHead = p.blockingScriptsInHead + p.blockingStylesheetsInHead;
  if (blockingHead >= HEURISTIC_BLOCKING_HEAD_RESOURCES) {
    issues.push({
      code: "speed_render_blocking_heuristic",
      category: "speed",
      severity: blockingHead >= 8 ? "warning" : "notice",
      url: p.url,
      message: `${blockingHead} render-blocking resource(s) in <head> (${p.blockingScriptsInHead} script(s) without async/defer, ${p.blockingStylesheetsInHead} stylesheet(s)).`,
      evidence: {
        blocking_scripts_in_head: p.blockingScriptsInHead,
        blocking_stylesheets_in_head: p.blockingStylesheetsInHead,
      },
    });
  }

  if (p.imagesWithoutDimensions > 0) {
    issues.push({
      code: "speed_image_dimensions_missing",
      category: "speed",
      severity: p.imagesWithoutDimensions >= 5 ? "warning" : "notice",
      url: p.url,
      message: `${p.imagesWithoutDimensions} of ${p.imgCount} image(s) have no width/height — they cause layout shift (CLS) as they load.`,
      evidence: { images_without_dimensions: p.imagesWithoutDimensions, images_total: p.imgCount },
    });
  }

  if (p.offscreenImagesNotLazy > 0) {
    issues.push({
      code: "speed_offscreen_images",
      category: "speed",
      severity: p.offscreenImagesNotLazy >= 10 ? "warning" : "notice",
      url: p.url,
      message: `${p.offscreenImagesNotLazy} below-the-fold image(s) are not lazy-loaded (no loading="lazy").`,
      evidence: { offscreen_images_not_lazy: p.offscreenImagesNotLazy, images_total: p.imgCount },
    });
  }

  if (p.largestInlineBytes >= HEURISTIC_LARGE_INLINE_BYTES) {
    issues.push({
      code: "speed_large_inline_resource",
      category: "speed",
      severity: "notice",
      url: p.url,
      message: `A single inline <style>/<script> block is ${kb(p.largestInlineBytes)} (inline blocks total ${kb(p.totalInlineBytes)}) — it bloats the HTML and cannot be cached separately.`,
      evidence: { largest_inline_bytes: p.largestInlineBytes, total_inline_bytes: p.totalInlineBytes },
    });
  }

  if (p.htmlBytes >= HEURISTIC_HEAVY_HTML_BYTES) {
    issues.push({
      code: "speed_heavy_page_weight",
      category: "speed",
      severity: p.htmlBytes >= HEURISTIC_HEAVY_HTML_BYTES * 2 ? "warning" : "notice",
      url: p.url,
      message: `The HTML document is ${kb(p.htmlBytes)} before images/scripts — heavy to download and parse on mobile.`,
      evidence: { html_bytes: p.htmlBytes },
    });
  }

  if (p.domNodeCount >= HEURISTIC_LARGE_DOM_NODES) {
    issues.push({
      code: "speed_large_dom",
      category: "speed",
      severity: p.domNodeCount >= 3000 ? "warning" : "notice",
      url: p.url,
      message: `The page has roughly ${p.domNodeCount} HTML elements — a large DOM slows rendering and style recalculation.`,
      evidence: { dom_node_count: p.domNodeCount },
    });
  }

  return issues;
}

function kb(bytes: number): string {
  return `${Math.round((bytes / 1024) * 10) / 10} KB`;
}

// ---------------------------------------------------------------------------
// Speed checks — PageSpeed Insights (Lighthouse), only when a key is set
// ---------------------------------------------------------------------------

/** Core Web Vitals + the headline performance score from one PSI run. */
export interface PsiSummary {
  url: string;
  strategy: string;
  performanceScore: number; // 0..100
  lcpSeconds: number;
  cls: number;
  inpMs: number;
  tbtMs: number;
  ttfbMs: number;
  fcpSeconds: number;
}

/**
 * Map Lighthouse audit IDs to our speed issue codes. Mirrors the Go scanner's
 * SpeedAuditIssueMap (internal/scanner/issue_catalog.go) so the codes match
 * the dashboard, including the Lighthouse 12.6+ "*-insight" successors.
 */
export const SPEED_AUDIT_ISSUE_MAP: Record<string, string> = {
  "render-blocking-resources": "speed_render_blocking",
  "uses-optimized-images": "speed_unoptimized_images",
  "modern-image-formats": "speed_unoptimized_images",
  "uses-responsive-images": "speed_unoptimized_images",
  "unused-javascript": "speed_unused_javascript",
  "unused-css-rules": "speed_unused_css",
  "uses-text-compression": "speed_text_compression",
  "server-response-time": "speed_slow_server_response",
  "mainthread-work-breakdown": "speed_main_thread_work",
  "bootup-time": "speed_main_thread_work",
  "dom-size": "speed_large_dom",
  "offscreen-images": "speed_offscreen_images",
  "uses-long-cache-ttl": "speed_efficient_cache",
  // Lighthouse 12.6+ "insight" audits — successors of the classic audits.
  "render-blocking-insight": "speed_render_blocking",
  "image-delivery-insight": "speed_unoptimized_images",
  "cache-insight": "speed_efficient_cache",
  "document-latency-insight": "speed_slow_server_response",
  "dom-size-insight": "speed_large_dom",
};

/** Audits that ARE the metric values — reported in the summary, not as problems. */
const METRIC_AUDITS = new Set([
  "first-contentful-paint",
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
  "speed-index",
  "interaction-to-next-paint",
  "metrics",
  "max-potential-fid",
  "first-meaningful-paint",
  "interactive",
]);

/** Below this estimated savings a Lighthouse opportunity is cosmetic — skipped. */
const MIN_OPPORTUNITY_SAVINGS_MS = 150;

interface LighthouseAudit {
  title?: string;
  score?: number | null;
  numericValue?: number;
  displayValue?: string;
  details?: { type?: string; overallSavingsMs?: number };
}

interface LighthouseResult {
  categories?: {
    performance?: { score?: number | null; auditRefs?: { id: string }[] };
  };
  audits?: Record<string, LighthouseAudit>;
}

/** The slice of the PSI API response we read. */
export interface PsiApiResponse {
  lighthouseResult?: LighthouseResult;
}

/**
 * Parse a raw PSI API response into a CWV summary. Returns null when the
 * payload has no usable Lighthouse result (error / unexpected shape).
 */
export function parsePsiResponse(raw: PsiApiResponse, url: string, strategy: string): PsiSummary | null {
  const lh = raw.lighthouseResult;
  if (!lh || !lh.audits) return null;
  const audits = lh.audits;
  const perf = lh.categories?.performance;
  const score = typeof perf?.score === "number" ? Math.round(perf.score * 100) : 0;
  const num = (id: string): number => (typeof audits[id]?.numericValue === "number" ? (audits[id].numericValue as number) : 0);
  return {
    url,
    strategy,
    performanceScore: score,
    lcpSeconds: num("largest-contentful-paint") / 1000,
    cls: num("cumulative-layout-shift"),
    inpMs: num("interaction-to-next-paint"),
    tbtMs: num("total-blocking-time"),
    ttfbMs: num("server-response-time"),
    fcpSeconds: num("first-contentful-paint") / 1000,
  };
}

/**
 * Turn one PSI response into speed issues, mirroring the Go scanner's
 * buildIssues: failing performance audits grouped by mapped code with the
 * severity banded by aggregated estimated savings, plus a synthetic
 * speed_low_score for a poor overall score.
 */
export function psiToIssues(raw: PsiApiResponse, url: string): Issue[] {
  const lh = raw.lighthouseResult;
  if (!lh || !lh.audits) return [];
  const audits = lh.audits;
  const perf = lh.categories?.performance;
  const perfIds = new Set((perf?.auditRefs || []).map((r) => r.id));
  const score = typeof perf?.score === "number" ? Math.round(perf.score * 100) : 0;

  type Group = { savings: number; audits: { id: string; title: string; savings_ms: number; display_value?: string }[] };
  const groups = new Map<string, Group>();

  for (const [id, a] of Object.entries(audits)) {
    if (typeof a.score !== "number" || a.score >= 0.9) continue; // passing / informative
    if (METRIC_AUDITS.has(id)) continue; // shown in the summary, not as a problem
    if (perfIds.size > 0 && !perfIds.has(id)) continue; // not a performance-category audit
    const code = SPEED_AUDIT_ISSUE_MAP[id];
    if (!code) continue; // audit we don't map
    const savings = a.details?.overallSavingsMs ?? 0;
    if (savings > 0 && savings < MIN_OPPORTUNITY_SAVINGS_MS) continue; // cosmetic
    let g = groups.get(code);
    if (!g) {
      g = { savings: 0, audits: [] };
      groups.set(code, g);
    }
    g.savings += savings;
    g.audits.push({ id, title: a.title ?? id, savings_ms: savings, display_value: a.displayValue });
  }

  const issues: Issue[] = [];
  for (const code of [...groups.keys()].sort()) {
    const g = groups.get(code)!;
    g.audits.sort((x, y) => y.savings_ms - x.savings_ms);
    issues.push({
      code,
      category: "speed",
      severity: severityForSavings(g.savings),
      url,
      message: `${code.replace(/^speed_/, "").replace(/_/g, " ")}: estimated ${Math.round(g.savings)} ms of wasted load time.`,
      evidence: { savings_ms: g.savings, audits: g.audits, performance_score: score },
    });
  }

  const lowSev = lowScoreSeverity(score);
  if (lowSev) {
    const s = parsePsiResponse(raw, url, "");
    issues.push({
      code: "speed_low_score",
      category: "speed",
      severity: lowSev,
      url,
      message: `Overall performance score is ${score}/100.`,
      evidence: s
        ? { performance_score: score, lcp_seconds: round2(s.lcpSeconds), cls: round2(s.cls), tbt_ms: Math.round(s.tbtMs), inp_ms: Math.round(s.inpMs) }
        : { performance_score: score },
    });
  }

  return issues;
}

/** Band aggregated savings into a severity — mirrors the Go scanner. */
function severityForSavings(ms: number): Severity {
  if (ms >= 1000) return "error";
  if (ms >= 300) return "warning";
  return "notice";
}

/** Lighthouse traffic-light bands: <50 poor, 50-79 needs work, >=80 fine. */
function lowScoreSeverity(score: number): Severity | "" {
  if (score < 50) return "error";
  if (score < 80) return "warning";
  return "";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Site-level checks (llms.txt, robots.txt)
// ---------------------------------------------------------------------------

/** The AI crawler user-agents AEO cares about (superset of the scanner list). */
export const AI_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "PerplexityBot",
  "OAI-SearchBot",
  "anthropic-ai",
  "ChatGPT-User",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "Applebot-Extended",
  "meta-externalagent",
];

/**
 * Validate /llms.txt body against the minimum spec: a `#` title, ≥1 markdown
 * link, and ≥100 chars. Returns an Issue when missing or invalid, else [].
 */
export function checkLlmsTxt(siteUrl: string, status: number, body: string | null): Issue[] {
  const url = originPath(siteUrl, "/llms.txt");
  if (status === 0 || status >= 400 || body === null) {
    return [{ code: "llms_txt_missing", severity: "notice", url, message: "/llms.txt is missing — AI assistants have no curated entry point." }];
  }
  const text = body.trim();
  const violations: string[] = [];
  if (text.length < 100) violations.push("less_than_100_chars");
  if (!/^\s*#\s/m.test(text)) violations.push("missing_top_level_heading");
  if (!/\[[^\]]+\]\([^)]+\)/.test(text)) violations.push("no_markdown_links");
  if (violations.length === 0) return [];
  return [
    {
      code: "aeo_llms_txt_invalid",
      severity: "warning",
      url,
      message: `/llms.txt exists but is invalid: ${violations.join(", ")}.`,
      evidence: { violations, length: text.length },
    },
  ];
}

/**
 * Parse robots.txt and report which AI crawlers are blocked at the site root.
 * `status` is the HTTP status of /robots.txt; a 4xx/5xx or missing file means
 * everything is allowed (no issue).
 */
export function checkRobotsAiBots(siteUrl: string, status: number, body: string | null): Issue[] {
  const url = originPath(siteUrl, "/robots.txt");
  if (status === 0 || status >= 400 || body === null) return [];
  const blocked = AI_CRAWLERS.filter((bot) => robotsBlocksRoot(body, bot));
  if (blocked.length === 0) return [];
  return [
    {
      code: "aeo_robots_blocks_ai_bot",
      severity: "error",
      url,
      message: `robots.txt blocks AI crawler(s): ${blocked.join(", ")}.`,
      evidence: { blocked_bots: blocked, total_bots: AI_CRAWLERS.length },
    },
  ];
}

/**
 * Minimal robots.txt evaluator: does any group matching `userAgent` (or `*`)
 * disallow the site root `/`? A `Disallow: /` (or empty `Allow:`-less group)
 * blocks the root. We honor the most-specific matching group, falling back to
 * the `*` group — enough to catch the common "block all AI" patterns.
 */
export function robotsBlocksRoot(robotsTxt: string, userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  const lines = robotsTxt.split(/\r?\n/);

  // Group rules by their user-agent(s).
  type Group = { agents: string[]; disallows: string[]; allows: string[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let expectingAgents = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!expectingAgents || current === null) {
        current = { agents: [], disallows: [], allows: [] };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "disallow") {
      expectingAgents = false;
      if (current) current.disallows.push(value);
    } else if (field === "allow") {
      expectingAgents = false;
      if (current) current.allows.push(value);
    } else {
      expectingAgents = false;
    }
  }

  const matchExact = groups.filter((g) => g.agents.includes(ua));
  const matchStar = groups.filter((g) => g.agents.includes("*"));
  const applicable = matchExact.length > 0 ? matchExact : matchStar;
  if (applicable.length === 0) return false;

  // Root is blocked if any applicable group disallows "/" and no Allow re-opens it.
  for (const g of applicable) {
    const disallowsRoot = g.disallows.some((d) => d === "/" || d === "/*");
    const allowsRoot = g.allows.some((a) => a === "/" || a === "/*");
    if (disallowsRoot && !allowsRoot) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Aggregators
// ---------------------------------------------------------------------------

/** Run every per-page check and return the combined issue list. */
export function checkPage(p: PageData): Issue[] {
  if (p.statusCode >= 400) {
    return [
      {
        code: p.statusCode >= 500 ? "http_5xx" : "http_4xx",
        severity: "error",
        url: p.url,
        message: `Page returned HTTP ${p.statusCode}.`,
        evidence: { status_code: p.statusCode },
      },
    ];
  }
  return [
    ...checkTitle(p),
    ...checkMetaDescription(p),
    ...checkH1(p),
    ...checkImages(p),
    ...checkHeadingEmoji(p),
    ...checkHeadingTooLong(p),
    ...checkHeadingHierarchy(p),
    ...checkHeadingBeforeH1(p),
    ...checkMixedContent(p),
    ...checkCanonical(p),
    ...checkViewport(p),
    ...checkOpenGraph(p),
    ...checkStructuredData(p),
    ...checkAeoArticleSchema(p),
    ...checkAeoMetaTags(p),
    ...checkSpeedHeuristics(p),
  ];
}

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

function okStatus(p: PageData): boolean {
  return p.statusCode >= 200 && p.statusCode < 400;
}

function outline(headings: HeadingInfo[]): { level: number; text: string }[] {
  return headings.slice(0, 100).map((h) => ({ level: h.level, text: h.text.slice(0, 160) }));
}

function dedupeByCode(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const i of issues) {
    const key = i.code + "|" + (i.evidence ? JSON.stringify(i.evidence) : "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

/** Build `origin + path` from a site URL, falling back to the input on error. */
export function originPath(siteUrl: string, path: string): string {
  try {
    const u = new URL(siteUrl);
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return siteUrl.replace(/\/+$/, "") + path;
  }
}
