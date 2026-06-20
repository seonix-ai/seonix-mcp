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

import { VALID_SCHEMA_ORG_TYPES } from "./schema-types.js";

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

  // --- Content / links / language (mirror the scanner's PageInput) ---
  /** Visible-text word count (script/style/noscript text excluded). */
  wordCount: number;
  /** Normalized ISO 639-1 language from <html lang> (e.g. "de"), or "". */
  lang: string;
  /** Count of distinct internal links (same registrable host). */
  internalLinks: number;
  /** Count of distinct external links (other hosts). */
  externalLinks: number;
  /** Resolved, de-duplicated internal link URLs (for the crawl-graph checks). */
  internalLinkUrls: string[];

  // --- Crawl metadata (filled by the orchestrator, NOT the HTML parser) ---
  /** Redirect chain that led to this page ({url, statusCode} per hop). */
  redirectChain: { url: string; statusCode: number }[];
  /** True when this entry is a redirect source stub, not a final page. */
  isRedirect: boolean;
  /** Shortest click-depth from the homepage (BFS); 0 = homepage / unknown. */
  crawlDepth: number;
  /** True when this URL was listed in the sitemap. */
  inSitemap: boolean;
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
 * Normalize a URL for cross-page comparison: lowercase scheme + host, drop the
 * fragment, drop a trailing slash (except on the root path). Mirrors the
 * scanner's urlutil.NormalizeURL so internal-link / orphaned comparisons line
 * up with the dashboard. Returns the input unchanged on parse failure.
 */
export function normalizeUrlKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    let path = u.pathname;
    if (path !== "/" && path.endsWith("/")) path = path.replace(/\/+$/, "");
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return raw;
  }
}

/** Read the language from <html lang="…">, normalized to its ISO 639-1 prefix. */
export function extractHtmlLang(html: string): string {
  const m = /<html\b[^>]*>/i.exec(html);
  if (!m) return "";
  const raw = (attr(m[0], "lang") || "").trim().toLowerCase();
  if (raw === "") return "";
  const dash = raw.search(/[-_]/);
  return dash > 0 ? raw.slice(0, dash) : raw;
}

/**
 * Visible-text word count. Mirrors the crawler: strip <script>/<style>/
 * <noscript> blocks, then count whitespace-separated tokens that contain at
 * least one letter (so "—", "123", "•" alone are not words).
 */
export function countVisibleWords(html: string): number {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  const text = stripTags(stripped);
  let count = 0;
  for (const token of text.split(/\s+/)) {
    if (token && /\p{L}/u.test(token)) count++;
  }
  return count;
}

/**
 * Extract internal vs external links from <a href> tags. Internal = same host
 * as the page; mailto/tel/javascript/data/sms and bare fragments are ignored.
 * Internal URLs are normalized + de-duplicated for the crawl-graph checks.
 */
export function extractLinks(html: string, pageUrl: string): { internalUrls: string[]; externalCount: number } {
  let host = "";
  try {
    host = new URL(pageUrl).host.toLowerCase();
  } catch {
    /* leave host empty — everything counts as external */
  }
  const internal = new Set<string>();
  const external = new Set<string>();
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    const href = (attr(tag, "href") || "").trim();
    if (href === "" || href.startsWith("#")) continue;
    if (/^(mailto:|tel:|javascript:|data:|sms:|callto:)/i.test(href)) continue;
    const resolved = resolveUrl(href, pageUrl);
    let rHost = "";
    try {
      rHost = new URL(resolved).host.toLowerCase();
    } catch {
      continue;
    }
    if (host !== "" && rHost === host) internal.add(normalizeUrlKey(resolved));
    else external.add(normalizeUrlKey(resolved));
  }
  return { internalUrls: [...internal], externalCount: external.size };
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

  // Content / links / language.
  const wordCount = countVisibleWords(html);
  const lang = extractHtmlLang(html);
  const { internalUrls, externalCount } = extractLinks(html, finalUrl);

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
    wordCount,
    lang,
    internalLinks: internalUrls.length,
    externalLinks: externalCount,
    internalLinkUrls: internalUrls,
    // Crawl metadata defaults — the orchestrator overwrites these after the
    // crawl graph is known. parsePage only sees a single page's HTML.
    redirectChain: [],
    isRedirect: false,
    crawlDepth: 0,
    inSitemap: false,
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

/** A single Schema.org node flattened out of any JSON-LD block. */
interface SchemaNode {
  blockIndex: number;
  types: string[];
  raw: Record<string, unknown>;
}

/** @type values treated as "Article-like" for the author/dates checks. */
const ARTICLE_TYPES = new Set(["Article", "BlogPosting", "NewsArticle"]);

/** Read @type as a string list (single string or array form). */
function extractTypes(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Extract Schema.org nodes from one of the three valid JSON-LD shapes:
 * a single object, an array of objects, or an @graph wrapper. Recurses ONLY
 * into @graph and arrays — NOT into arbitrary nested objects — exactly like
 * the scanner's extractNodes, so page-wide duplicate-type / author detection
 * matches the dashboard. (A nested Person inside Article.author is resolved by
 * the author check, not collected as a top-level node.)
 */
function extractNodes(value: unknown, blockIndex: number, out: SchemaNode[]): void {
  if (Array.isArray(value)) {
    for (const v of value) extractNodes(v, blockIndex, out);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("@graph" in obj) {
      extractNodes(obj["@graph"], blockIndex, out);
      return;
    }
    out.push({ blockIndex, types: extractTypes(obj), raw: obj });
  }
}

/** Parse all JSON-LD blocks into flattened nodes. Malformed blocks skip. */
function parseSchemaNodes(blocks: string[]): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    try {
      extractNodes(JSON.parse(blocks[i]), i, out);
    } catch {
      // Malformed JSON-LD is reported by invalid_structured_data, not here.
    }
  }
  return out;
}

function isArticleLike(n: SchemaNode): boolean {
  return n.types.some((t) => ARTICLE_TYPES.has(t));
}

function nodeIsType(n: SchemaNode, want: string): boolean {
  return n.types.includes(want);
}

/**
 * Strip the schema.org IRI prefix (full URL or "schema:" compact form) so
 * "https://schema.org/Article", "schema:Article" and "Article" all resolve to
 * the same lookup key. @type is case-sensitive, so case is preserved.
 */
function normalizeSchemaType(t: string): string {
  let s = t.trim();
  s = s.replace(/^https?:\/\/schema\.org\//, "");
  s = s.replace(/^schema:/, "");
  return s;
}

/** Pull a comparable string from an author field (string or {name}). */
function stringFromAuthor(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const name = (v as Record<string, unknown>)["name"];
    if (typeof name === "string") return name;
  }
  return "";
}

/** Resolve an author's @id reference against the page's nodes → is it a Person? */
function authorRefIsPerson(author: Record<string, unknown>, nodes: SchemaNode[]): boolean {
  const id = typeof author["@id"] === "string" ? (author["@id"] as string).trim() : "";
  if (id === "") return false;
  for (const n of nodes) {
    if (n.raw["@id"] === id) return nodeIsType(n, "Person");
  }
  return false;
}

/** True when the node carries a non-empty value for any of the given keys. */
function hasAnyOf(node: Record<string, unknown>, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === "string" && v.trim() !== "") return true;
    if (v && typeof v === "object" && !Array.isArray(v)) return true;
    if (Array.isArray(v) && v.length > 0) return true;
  }
  return false;
}

function stringFromNode(n: SchemaNode, key: string): string {
  const v = n.raw[key];
  return typeof v === "string" ? v : "";
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

/**
 * AEO JSON-LD analytics — mirrors the scanner's CheckAEOStructuredData +
 * CheckAEOSchemaConsistency. Runs on top of checkStructuredData (presence /
 * JSON validity). Parses the page's JSON-LD once and runs every sub-check:
 * duplicate/conflicting type, unrecognized type, Article author not a Person,
 * incomplete Person, missing dates, and FAQ/HowTo schema not visible on-page.
 */
export function checkAeoStructuredData(p: PageData): Issue[] {
  if (!okStatus(p) || p.jsonLd.length === 0) return [];
  const nodes = parseSchemaNodes(p.jsonLd);
  if (nodes.length === 0) return [];
  return [
    ...checkDuplicateAndConflicting(p.url, nodes),
    ...checkRecognizedTypes(p.url, nodes),
    ...checkArticleAuthor(p.url, nodes),
    ...checkPersonCompleteness(p.url, nodes),
    ...checkArticleDates(p.url, nodes),
    ...checkSchemaConsistency(p, nodes),
  ];
}

/** Group nodes by @type; 2+ of a type → duplicate, or conflicting if fields disagree. */
function checkDuplicateAndConflicting(url: string, nodes: SchemaNode[]): Issue[] {
  const byType = new Map<string, SchemaNode[]>();
  for (const n of nodes) {
    for (const t of n.types) {
      const arr = byType.get(t);
      if (arr) arr.push(n);
      else byType.set(t, [n]);
    }
  }
  const issues: Issue[] = [];
  for (const [t, group] of byType) {
    if (group.length < 2) continue;
    const conflictField = firstConflictField(group);
    const blockIndexes = [...new Set(group.map((n) => n.blockIndex))];
    if (conflictField) {
      issues.push({
        code: "aeo_jsonld_conflicting_data",
        category: "aeo",
        severity: "warning",
        url,
        message: `Two or more "${t}" JSON-LD blocks disagree on ${conflictField}.`,
        evidence: { type: t, block_count: group.length, block_indexes: blockIndexes, conflict_field: conflictField },
      });
    } else {
      issues.push({
        code: "aeo_jsonld_duplicate_type",
        category: "aeo",
        severity: "warning",
        url,
        message: `The "${t}" schema type appears in ${group.length} JSON-LD blocks on this page.`,
        evidence: { type: t, block_count: group.length, block_indexes: blockIndexes },
      });
    }
  }
  return issues;
}

/** First of headline/name/datePublished/dateModified/author.name that differs across the group. */
function firstConflictField(group: SchemaNode[]): string {
  for (const f of ["headline", "name", "datePublished", "dateModified"]) {
    const values = new Set<string>();
    for (const n of group) {
      const v = n.raw[f];
      if (typeof v === "string" && v !== "") values.add(v);
    }
    if (values.size > 1) return f;
  }
  const authors = new Set<string>();
  for (const n of group) {
    if ("author" in n.raw) {
      const name = stringFromAuthor(n.raw["author"]);
      if (name !== "") authors.add(name);
    }
  }
  return authors.size > 1 ? "author.name" : "";
}

/** Flag @type values absent from the schema.org vocabulary (typos / invented types). */
function checkRecognizedTypes(url: string, nodes: SchemaNode[]): Issue[] {
  const unrecognized = new Set<string>();
  for (const n of nodes) {
    for (const t of n.types) {
      const norm = normalizeSchemaType(t);
      if (norm === "") continue;
      if (!VALID_SCHEMA_ORG_TYPES.has(norm)) unrecognized.add(t);
    }
  }
  if (unrecognized.size === 0) return [];
  return [
    {
      code: "aeo_jsonld_type_not_recognized",
      category: "aeo",
      severity: "notice",
      url,
      message: `JSON-LD uses an @type not in the schema.org vocabulary: ${[...unrecognized].join(", ")}.`,
      evidence: { types: [...unrecognized] },
    },
  ];
}

/**
 * Article author must be a Person. Yoast & most SEO plugins emit the author as
 * a bare @id reference to a Person node in the @graph (no inline @type), so we
 * resolve the reference before flagging — otherwise every Yoast site is a false
 * positive. A legacy string author ("author":"Jane Doe") is tolerated.
 */
function checkArticleAuthor(url: string, nodes: SchemaNode[]): Issue[] {
  for (const n of nodes) {
    if (!isArticleLike(n)) continue;
    const author = n.raw["author"];
    if (author && typeof author === "object" && !Array.isArray(author)) {
      const a = author as Record<string, unknown>;
      if (typesContain(extractTypes(a), "Person") || authorRefIsPerson(a, nodes)) continue;
      const t = typeof a["@type"] === "string" ? (a["@type"] as string) : "";
      return [
        {
          code: "aeo_jsonld_author_not_person",
          category: "aeo",
          severity: "notice",
          url,
          message: `Article JSON-LD author is "${t || "(untyped)"}", not a Person.`,
          evidence: { actual_type: t === "" ? "(untyped)" : t, article_node_id: stringFromNode(n, "@id") },
        },
      ];
    }
  }
  return [];
}

function typesContain(types: string[], want: string): boolean {
  return types.includes(want);
}

/** Every Person (top-level or inline Article.author) needs url/image/jobTitle beyond name. */
function checkPersonCompleteness(url: string, nodes: SchemaNode[]): Issue[] {
  for (const n of nodes) {
    if (!nodeIsType(n, "Person")) continue;
    if (hasAnyOf(n.raw, "url", "image", "jobTitle")) continue;
    return [
      {
        code: "aeo_jsonld_person_incomplete",
        category: "aeo",
        severity: "notice",
        url,
        message: `Person "${stringFromNode(n, "name")}" has only a name — add url, image, or jobTitle.`,
        evidence: { person_name: stringFromNode(n, "name"), missing_signals: ["url", "image", "jobTitle"] },
      },
    ];
  }
  for (const n of nodes) {
    if (!isArticleLike(n)) continue;
    const a = n.raw["author"];
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const author = a as Record<string, unknown>;
    if (author["@type"] !== "Person") continue;
    if (hasAnyOf(author, "url", "image", "jobTitle")) continue;
    const name = typeof author["name"] === "string" ? (author["name"] as string) : "";
    return [
      {
        code: "aeo_jsonld_person_incomplete",
        category: "aeo",
        severity: "notice",
        url,
        message: `Article author "${name}" has only a name — add url, image, or jobTitle.`,
        evidence: { person_name: name, missing_signals: ["url", "image", "jobTitle"], location: "Article.author" },
      },
    ];
  }
  return [];
}

/** Article-like nodes missing datePublished (a lone missing dateModified is fine). */
function checkArticleDates(url: string, nodes: SchemaNode[]): Issue[] {
  for (const n of nodes) {
    if (!isArticleLike(n)) continue;
    if ("datePublished" in n.raw) continue;
    return [
      {
        code: "aeo_jsonld_dates_missing",
        category: "aeo",
        severity: "notice",
        url,
        message: "Article JSON-LD is missing datePublished.",
        evidence: { missing_fields: ["datePublished"], article_node_id: stringFromNode(n, "@id") },
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// AEO — JSON-LD vs visible content (FAQ / HowTo) — mirror schema_consistency.go
// ---------------------------------------------------------------------------

/** FAQ/HowTo schema present but <50% of its questions/steps appear as headings. */
function checkSchemaConsistency(p: PageData, nodes: SchemaNode[]): Issue[] {
  const headings = p.headings.map((h) => normalizeForMatch(h.text)).filter((s) => s !== "");
  const issues: Issue[] = [];

  for (const n of nodes) {
    if (!nodeIsType(n, "FAQPage")) continue;
    const questions = extractFAQQuestions(n);
    if (questions.length < 2) continue;
    const matched = countMatchingHeadings(questions, headings);
    if (matched / questions.length >= 0.5) continue;
    issues.push({
      code: "aeo_jsonld_faq_without_content",
      category: "aeo",
      severity: "warning",
      url: p.url,
      message: `FAQPage schema has ${questions.length} questions but only ${matched} appear as headings on the page.`,
      evidence: { total_questions: questions.length, questions_in_headings: matched, missing_questions: missingItems(questions, headings) },
    });
    break; // one FAQ issue per page
  }

  for (const n of nodes) {
    if (!nodeIsType(n, "HowTo")) continue;
    const steps = extractHowToStepNames(n);
    if (steps.length < 2) continue;
    const matched = countMatchingHeadings(steps, headings);
    if (matched / steps.length >= 0.5) continue;
    issues.push({
      code: "aeo_jsonld_howto_without_steps",
      category: "aeo",
      severity: "warning",
      url: p.url,
      message: `HowTo schema has ${steps.length} steps but only ${matched} appear as headings on the page.`,
      evidence: { total_steps: steps.length, steps_in_headings: matched, missing_steps: missingItems(steps, headings) },
    });
    break; // one HowTo issue per page
  }

  return issues;
}

/** Pull mainEntity[*].name from a FAQPage node (mainEntity may be one object or an array). */
function extractFAQQuestions(n: SchemaNode): string[] {
  const me = n.raw["mainEntity"];
  if (Array.isArray(me)) return collectNames(me);
  if (me && typeof me === "object") {
    const name = (me as Record<string, unknown>)["name"];
    if (typeof name === "string" && name !== "") return [name];
  }
  return [];
}

/** Pull step[*].name (or truncated .text) from a HowTo node. */
function extractHowToStepNames(n: SchemaNode): string[] {
  const steps = n.raw["step"];
  if (Array.isArray(steps)) {
    const names: string[] = [];
    for (const item of steps) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const name = obj["name"];
      if (typeof name === "string" && name.trim() !== "") {
        names.push(name);
        continue;
      }
      const text = obj["text"];
      if (typeof text === "string" && text.trim() !== "") names.push(text.slice(0, 80));
    }
    return names;
  }
  if (steps && typeof steps === "object") {
    const name = (steps as Record<string, unknown>)["name"];
    if (typeof name === "string" && name !== "") return [name];
  }
  return [];
}

function collectNames(items: unknown[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item && typeof item === "object") {
      const name = (item as Record<string, unknown>)["name"];
      if (typeof name === "string" && name.trim() !== "") out.push(name);
    }
  }
  return out;
}

/** Lowercase, keep only letters/digits + single spaces (permissive fuzzy match). */
function normalizeForMatch(s: string): string {
  let out = "";
  let prevSpace = false;
  for (const r of s.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(r)) {
      out += r;
      prevSpace = false;
    } else if (/\s/u.test(r)) {
      if (!prevSpace && out.length > 0) {
        out += " ";
        prevSpace = true;
      }
    }
  }
  return out.replace(/ +$/, "");
}

/** How many needles appear (bidirectional substring) in any normalized heading. */
function countMatchingHeadings(needles: string[], headings: string[]): number {
  let matched = 0;
  for (const raw of needles) {
    const needle = normalizeForMatch(raw);
    if (needle === "") continue;
    if (headings.some((h) => h.includes(needle) || needle.includes(h))) matched++;
  }
  return matched;
}

/** Up to 5 needles that matched no heading (for the issue evidence). */
function missingItems(needles: string[], headings: string[]): string[] {
  const missing: string[] = [];
  for (const raw of needles) {
    const needle = normalizeForMatch(raw);
    if (needle === "") continue;
    if (!headings.some((h) => h.includes(needle) || needle.includes(h))) missing.push(raw);
    if (missing.length >= 5) break;
  }
  return missing;
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
// Title quality (HTML entities, lowercase start) — mirror title_quality.go
// ---------------------------------------------------------------------------

/**
 * Well-formed HTML entities only: named (&amp;), decimal (&#160;) or hex
 * (&#xA0;), each terminated by a semicolon. Strict on purpose — "AT&T" and
 * "Tom & Jerry" never match because the ampersand has no entity body + ";".
 */
const HTML_ENTITY_RE = /&(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g;

/** Languages where "first letter must be uppercase" is a real convention. */
const TITLE_LOWERCASE_LANGS = new Set(["de", "en", "ru"]);

/** camelCase / lower-prefix brands whose titles legitimately start lowercase. */
const TITLE_LOWERCASE_BRANDS = [
  "iPhone", "iPad", "iPod", "iCloud", "iMac", "iOS", "iTunes",
  "macOS", "tvOS", "watchOS", "ipadOS",
  "eBay", "mRNA",
];

export function checkTitleHtmlEntities(p: PageData): Issue[] {
  if (!okStatus(p) || p.title === "") return [];
  const matches = p.title.match(HTML_ENTITY_RE);
  if (!matches || matches.length === 0) return [];
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (seen.has(m)) continue;
    seen.add(m);
    uniq.push(m);
  }
  return [
    {
      code: "title_html_entities",
      severity: "warning",
      url: p.url,
      message: `Title contains undecoded HTML entit${uniq.length === 1 ? "y" : "ies"}: ${uniq.join(", ")}.`,
      evidence: { entities_found: uniq, title: p.title },
    },
  ];
}

export function checkTitleLowercase(p: PageData): Issue[] {
  if (!okStatus(p) || p.title === "") return [];
  if (!TITLE_LOWERCASE_LANGS.has(p.lang)) return [];

  // Trim leading whitespace incl. tab / zero-width space (mirrors TrimLeft).
  const trimmed = p.title.replace(/^[\s​]+/, "");
  if (trimmed === "") return [];

  const first = [...trimmed][0];
  if (!/\p{L}/u.test(first)) return []; // not a letter (digit, emoji, quote, …)
  if (!/\p{Ll}/u.test(first)) return []; // already uppercase / caseless

  // Brand whitelist: case-sensitive prefix bounded by a non-letter/digit (or EOS).
  for (const brand of TITLE_LOWERCASE_BRANDS) {
    if (!trimmed.startsWith(brand)) continue;
    const rest = trimmed.slice(brand.length);
    if (rest === "") return [];
    const next = [...rest][0];
    if (!/[\p{L}\p{N}]/u.test(next)) return [];
  }

  return [
    {
      code: "title_lowercase",
      severity: "notice",
      url: p.url,
      message: `Title starts with a lowercase letter ("${first}"): "${trimmed.slice(0, 60)}".`,
      evidence: { title: p.title, language: p.lang, first_char: first },
    },
  ];
}

// ---------------------------------------------------------------------------
// Content / links / indexability — mirror checks.go (checkContent, checkLinks,
// checkNoindex, checkSoft404)
// ---------------------------------------------------------------------------

const LOW_WORD_COUNT = 300;
const SOFT_404_MAX_WORDS = 100;

/** Title fragments that, with a thin body, signal a "200 but really an error" page. */
const SOFT_404_INDICATORS = [
  "page not found",
  "404",
  "not found",
  "fehler",
  "seite nicht gefunden",
  "pagina niet gevonden",
  "page introuvable",
  "pagina non trovata",
];

export function checkLowWordCount(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  if (p.wordCount >= LOW_WORD_COUNT) return [];
  return [
    {
      code: "low_word_count",
      severity: "warning",
      url: p.url,
      message: `Page has only ${p.wordCount} words (thin content; aim for 300+).`,
      evidence: { word_count: p.wordCount },
    },
  ];
}

export function checkNoInternalLinks(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  if (p.internalLinks > 0) return [];
  return [
    {
      code: "no_internal_links",
      severity: "notice",
      url: p.url,
      message: "Page has no internal links — it is isolated from the site structure.",
    },
  ];
}

export function checkNoindex(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const combined = (p.robotsDirectives + " " + p.xRobotsTag).toLowerCase();
  if (!combined.includes("noindex")) return [];
  return [
    {
      code: "noindex_detected",
      severity: "warning",
      url: p.url,
      message: "Page is set to noindex — it is excluded from search engines. Verify this is intentional.",
      evidence: { robots_directives: p.robotsDirectives, x_robots_tag: p.xRobotsTag },
    },
  ];
}

export function checkSoft404(p: PageData): Issue[] {
  if (p.statusCode !== 200) return [];
  const title = p.title.toLowerCase();
  for (const ind of SOFT_404_INDICATORS) {
    if (title.includes(ind) && p.wordCount < SOFT_404_MAX_WORDS) {
      return [
        {
          code: "soft_404",
          severity: "error",
          url: p.url,
          message: `Page returns HTTP 200 but looks like an error page (title "${p.title.slice(0, 60)}", ${p.wordCount} words).`,
          evidence: { title: p.title, word_count: p.wordCount },
        },
      ];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// AEO — incomplete social meta (aeo_og_incomplete) — mirror aeo_discovery.go
// ---------------------------------------------------------------------------

/**
 * Fires when 2+ of the 5 core social-meta tags (og:title, og:description,
 * og:image, og:url, twitter:card) are absent. A page missing only one (often
 * og:image on a privacy page) is tolerated. Distinct from missing_og_tags
 * (which fires when NONE are present) — both can legitimately coexist.
 */
export function checkAeoSocialMeta(p: PageData): Issue[] {
  if (!okStatus(p)) return [];
  const missing: string[] = [];
  if (!p.hasOgTitle) missing.push("og:title");
  if (!p.hasOgDescription) missing.push("og:description");
  if (p.ogImage === "") missing.push("og:image");
  if (!p.hasOgUrl) missing.push("og:url");
  if (!p.hasTwitterCard) missing.push("twitter:card");
  if (missing.length < 2) return [];
  return [
    {
      code: "aeo_og_incomplete",
      category: "aeo",
      severity: "notice",
      url: p.url,
      message: `Page is missing ${missing.length} core social-meta tag(s): ${missing.join(", ")}.`,
      evidence: { missing_tags: missing, missing_count: missing.length },
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

interface RobotsGroup {
  agents: string[];
  disallows: string[];
  allows: string[];
}

/** Parse robots.txt into user-agent groups (lowercased agents + raw paths). */
function parseRobotsGroups(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let expectingAgents = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
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
  return groups;
}

/** The groups applicable to a UA: exact matches, else the `*` group. */
function applicableGroups(groups: RobotsGroup[], ua: string): RobotsGroup[] {
  const exact = groups.filter((g) => g.agents.includes(ua));
  return exact.length > 0 ? exact : groups.filter((g) => g.agents.includes("*"));
}

/**
 * Minimal robots.txt evaluator: does any group matching `userAgent` (or `*`)
 * disallow the site root `/`? Used for the AI-bot block list — a `Disallow: /`
 * (or `/*`) with no re-opening Allow blocks the root.
 */
export function robotsBlocksRoot(robotsTxt: string, userAgent: string): boolean {
  const applicable = applicableGroups(parseRobotsGroups(robotsTxt), userAgent.toLowerCase());
  if (applicable.length === 0) return false;
  for (const g of applicable) {
    const disallowsRoot = g.disallows.some((d) => d === "/" || d === "/*");
    const allowsRoot = g.allows.some((a) => a === "/" || a === "/*");
    if (disallowsRoot && !allowsRoot) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Robots path pattern match: supports `*` wildcard and `$` end-anchor. */
function pathMatchesRobots(path: string, pattern: string): boolean {
  if (pattern === "" || pattern === "/") return true;
  const anchored = pattern.endsWith("$");
  const pat = anchored ? pattern.slice(0, -1) : pattern;
  const re = pat.split("*").map(escapeRegex).join(".*");
  try {
    return new RegExp("^" + re + (anchored ? "$" : "")).test(path);
  } catch {
    return path.startsWith(pat);
  }
}

/**
 * Longest-match robots.txt evaluator (mirrors RobotsData.IsAllowed): the most
 * specific (longest) matching Allow/Disallow rule wins; a tie favors Allow; an
 * empty `Disallow:` imposes no constraint; no applicable rule means allowed.
 */
export function robotsAllows(robotsTxt: string, userAgent: string, targetPath: string): boolean {
  const applicable = applicableGroups(parseRobotsGroups(robotsTxt), userAgent.toLowerCase());
  if (applicable.length === 0) return true;
  let best = { len: -1, allow: true };
  const consider = (rule: string, allow: boolean) => {
    if (rule === "" && !allow) return; // empty Disallow = allow all → no constraint
    if (!pathMatchesRobots(targetPath, rule)) return;
    if (rule.length > best.len || (rule.length === best.len && allow)) best = { len: rule.length, allow };
  };
  for (const g of applicable) {
    for (const d of g.disallows) consider(d, false);
    for (const a of g.allows) consider(a, true);
  }
  return best.len === -1 ? true : best.allow;
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
      // broken_redirect fires here when a redirect chain ends in 4xx/5xx.
      ...checkRedirects(p),
    ];
  }
  return [
    ...checkTitle(p),
    ...checkTitleHtmlEntities(p),
    ...checkTitleLowercase(p),
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
    ...checkNoindex(p),
    ...checkLowWordCount(p),
    ...checkNoInternalLinks(p),
    ...checkSoft404(p),
    ...checkOpenGraph(p),
    ...checkStructuredData(p),
    ...checkAeoStructuredData(p),
    ...checkAeoMetaTags(p),
    ...checkAeoSocialMeta(p),
    ...checkSpeedHeuristics(p),
    // too_many_redirects / redirect_loop when this 2xx page was reached via a chain.
    ...checkRedirects(p),
  ];
}

// ---------------------------------------------------------------------------
// Per-page redirect checks — mirror checks.go checkRedirects
// ---------------------------------------------------------------------------

/**
 * Redirect-chain findings, derived from the chain the orchestrator recorded
 * while following redirects manually: broken_redirect (chain ends 4xx/5xx),
 * redirect_loop (a URL repeats), too_many_redirects (> 2 hops).
 */
export function checkRedirects(p: PageData): Issue[] {
  if (p.redirectChain.length === 0) return [];
  const issues: Issue[] = [];
  const chain = p.redirectChain.map((h) => ({ url: h.url, status_code: h.statusCode }));

  if (p.statusCode >= 400) {
    issues.push({
      code: "broken_redirect",
      severity: "error",
      url: p.url,
      message: `Redirect chain ends in HTTP ${p.statusCode} after ${p.redirectChain.length} hop(s).`,
      evidence: { final_status_code: p.statusCode, hops: p.redirectChain.length, redirect_chain: chain },
    });
  }

  const seen = new Set<string>();
  for (const hop of p.redirectChain) {
    if (seen.has(hop.url)) {
      issues.push({
        code: "redirect_loop",
        severity: "error",
        url: p.url,
        message: "Redirect chain loops back to a URL it already visited.",
        evidence: { looping_url: hop.url, redirect_chain: chain },
      });
      break;
    }
    seen.add(hop.url);
  }

  if (p.redirectChain.length > 2) {
    issues.push({
      code: "too_many_redirects",
      severity: "warning",
      url: p.url,
      message: `${p.redirectChain.length} redirect hops before the final page (more than 2).`,
      evidence: { hops: p.redirectChain.length, redirect_chain: chain },
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Cross-page checks — duplicates, boilerplate, pagination (mirror duplicates.go,
// boilerplate.go, pagination.go). Each takes the full set of fetched pages.
// ---------------------------------------------------------------------------

const PAGINATION_ARCHIVE_RE = /\/page\/\d+\/?$/i;

/** True when the URL path is a paginated archive subpage (/…/page/2/). */
export function isPaginationArchiveURL(rawUrl: string): boolean {
  try {
    return PAGINATION_ARCHIVE_RE.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

/** True when a robots/meta directive string requests noindex. */
export function hasNoindexDirective(robotsDirectives: string): boolean {
  return robotsDirectives.toLowerCase().includes("noindex");
}

/** duplicate_title + duplicate_meta_desc + trailing_slash_duplicate over the page set. */
export function checkDuplicates(pages: PageData[]): Issue[] {
  return [
    ...checkDuplicateTitles(pages),
    ...checkDuplicateMetaDescriptions(pages),
    ...checkTrailingSlashDuplicates(pages),
  ];
}

function checkDuplicateTitles(pages: PageData[]): Issue[] {
  const byTitle = new Map<string, string[]>();
  for (const p of pages) {
    if (!okStatus(p) || isPaginationArchiveURL(p.url)) continue;
    const title = p.title.trim();
    if (title === "") continue;
    const arr = byTitle.get(title);
    if (arr) arr.push(p.url);
    else byTitle.set(title, [p.url]);
  }
  const issues: Issue[] = [];
  for (const [title, urls] of byTitle) {
    if (urls.length < 2) continue;
    for (const u of urls) {
      issues.push({
        code: "duplicate_title",
        severity: "warning",
        url: u,
        message: `${urls.length} pages share the title "${title.slice(0, 70)}".`,
        evidence: { title, duplicate_count: urls.length, duplicate_urls: urls.slice(0, 20) },
      });
    }
  }
  return issues;
}

function checkDuplicateMetaDescriptions(pages: PageData[]): Issue[] {
  const byDesc = new Map<string, string[]>();
  for (const p of pages) {
    if (!okStatus(p) || isPaginationArchiveURL(p.url)) continue;
    const desc = p.metaDescription.trim();
    if (desc === "") continue;
    const arr = byDesc.get(desc);
    if (arr) arr.push(p.url);
    else byDesc.set(desc, [p.url]);
  }
  const issues: Issue[] = [];
  for (const [desc, urls] of byDesc) {
    if (urls.length < 2) continue;
    for (const u of urls) {
      issues.push({
        code: "duplicate_meta_desc",
        severity: "warning",
        url: u,
        message: `${urls.length} pages share the same meta description.`,
        evidence: { meta_description: desc, duplicate_count: urls.length, duplicate_urls: urls.slice(0, 20) },
      });
    }
  }
  return issues;
}

function checkTrailingSlashDuplicates(pages: PageData[]): Issue[] {
  const urlSet = new Set<string>();
  for (const p of pages) {
    if (p.statusCode === 200 && !p.isRedirect) urlSet.add(p.url);
  }
  const reported = new Set<string>();
  const issues: Issue[] = [];
  for (const p of pages) {
    if (p.statusCode !== 200 || p.isRedirect) continue;
    const trimmed = p.url.replace(/\/+$/, "");
    if (trimmed === "") continue;
    // Skip bare-origin URLs (https://host) — a trailing slash is normal there.
    const afterScheme = trimmed.split("://");
    if (afterScheme.length === 2 && !afterScheme[1].includes("/")) continue;
    const counterpart = p.url.endsWith("/") ? trimmed : p.url + "/";
    if (!urlSet.has(counterpart)) continue;
    if (reported.has(trimmed)) continue;
    reported.add(trimmed);
    issues.push({
      code: "trailing_slash_duplicate",
      severity: "warning",
      url: p.url,
      message: "Both the trailing-slash and non-trailing-slash URLs return content (duplicate).",
      evidence: { duplicate_url: counterpart },
    });
  }
  return issues;
}

const BOILERPLATE_MIN_SITE_PAGES = 10;
const BOILERPLATE_RATIO = 0.5;
const BOILERPLATE_MIN_CHARS = 3;

/** Strip zero-width / format chars, collapse whitespace, lowercase. */
function normalizeBoilerplateHeading(s: string): string {
  let stripped = "";
  for (const r of s) {
    if (!/\p{Cf}/u.test(r)) stripped += r;
  }
  return stripped.trim().replace(/\s+/g, " ").toLowerCase();
}

/** boilerplate_heading_repeated — an H2-H6 appearing on >50% of pages (≥10 pages). */
export function checkBoilerplateHeadings(pages: PageData[]): Issue[] {
  const filtered = pages.filter((p) => okStatus(p) && !p.isRedirect);
  const total = filtered.length;
  if (total < BOILERPLATE_MIN_SITE_PAGES) return [];

  interface Group {
    originalText: string;
    level: number;
    urls: string[];
    urlSet: Set<string>;
  }
  const groups = new Map<string, Group>();
  for (const p of filtered) {
    const seenOnPage = new Set<string>();
    for (const h of p.headings) {
      if (h.level === 1) continue; // H1 boilerplate is duplicate_title / h1_multiple's job
      const key = normalizeBoilerplateHeading(h.text);
      if (key.length < BOILERPLATE_MIN_CHARS || seenOnPage.has(key)) continue;
      seenOnPage.add(key);
      let g = groups.get(key);
      if (!g) {
        g = { originalText: h.text.trim(), level: h.level, urls: [], urlSet: new Set() };
        groups.set(key, g);
      }
      if (!g.urlSet.has(p.url)) {
        g.urlSet.add(p.url);
        g.urls.push(p.url);
      }
    }
  }

  const threshold = Math.floor(total * BOILERPLATE_RATIO);
  const issues: Issue[] = [];
  for (const g of groups.values()) {
    if (g.urls.length <= threshold) continue; // strictly more than 50%
    const ratio = g.urls.length / total;
    for (const u of g.urls) {
      issues.push({
        code: "boilerplate_heading_repeated",
        severity: "notice",
        url: u,
        message: `Heading "${g.originalText.slice(0, 60)}" repeats on ${g.urls.length} of ${total} pages.`,
        evidence: { heading_text: g.originalText, heading_level: g.level, occurrence_count: g.urls.length, total_pages: total, ratio },
      });
    }
  }
  return issues;
}

/** pagination_noindex_recommended — one site-level notice when paginated archives aren't noindexed. */
export function checkPaginationNoindexRecommendation(pages: PageData[]): Issue[] {
  let siteOrigin = "";
  const paginated: string[] = [];
  let alreadyNoindex = 0;
  for (const p of pages) {
    if (p.isRedirect || !okStatus(p) || !isPaginationArchiveURL(p.url)) continue;
    if (siteOrigin === "") {
      try {
        const u = new URL(p.url);
        siteOrigin = `${u.protocol}//${u.host}/`;
      } catch {
        /* keep looking */
      }
    }
    if (hasNoindexDirective(p.robotsDirectives)) {
      alreadyNoindex++;
      continue;
    }
    paginated.push(p.url);
  }
  if (paginated.length === 0 || siteOrigin === "") return [];
  return [
    {
      code: "pagination_noindex_recommended",
      severity: "notice",
      url: siteOrigin,
      message: `${paginated.length} paginated archive subpage(s) are indexable — best practice is to noindex them.`,
      evidence: { paginated_url_count: paginated.length, examples: paginated.slice(0, 10), already_noindex: alreadyNoindex },
    },
  ];
}

// ---------------------------------------------------------------------------
// Crawl-graph checks — broken links, orphaned, crawl depth (mirror
// broken_links.go, orphaned.go, checks.go checkCrawlDepth)
// ---------------------------------------------------------------------------

/** Cloudflare-injected pseudo-links that are never real broken links. */
function isCloudflareLink(link: string): boolean {
  return link.includes("/cdn-cgi/") || link.includes("email-protection");
}

/** broken_internal_link — internal links pointing at a crawled URL that is 4xx/5xx. */
export function checkBrokenInternalLinks(pages: PageData[]): Issue[] {
  const statusMap = new Map<string, number>();
  for (const p of pages) {
    if (p.isRedirect) continue; // stubs carry 301/302, not the real status
    statusMap.set(normalizeUrlKey(p.url), p.statusCode);
    statusMap.set(normalizeUrlKey(p.finalUrl), p.statusCode);
  }
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const p of pages) {
    if (p.statusCode >= 400) continue; // only healthy pages linking to broken ones
    for (const link of p.internalLinkUrls) {
      if (isCloudflareLink(link)) continue;
      const key = normalizeUrlKey(link);
      const status = statusMap.get(key);
      if (status === undefined || status < 400) continue;
      const dedupeKey = p.url + "|" + key;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      issues.push({
        code: "broken_internal_link",
        severity: "error",
        url: p.url,
        message: `Internal link points to ${link} which returns HTTP ${status}.`,
        evidence: { broken_url: link, status_code: status, source_page: p.url },
      });
    }
  }
  return issues;
}

/** orphaned_page — a 200 page no other crawled page links to. */
export function checkOrphanedPages(pages: PageData[]): Issue[] {
  const linkedTo = new Set<string>();
  const rootURLs = new Set<string>();
  for (const p of pages) {
    if (!p.isRedirect && okStatus(p)) {
      for (const link of p.internalLinkUrls) linkedTo.add(normalizeUrlKey(link));
    }
    try {
      const u = new URL(p.url);
      const root = `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}`;
      rootURLs.add(normalizeUrlKey(root));
      rootURLs.add(normalizeUrlKey(root + "/"));
    } catch {
      /* skip */
    }
  }
  const issues: Issue[] = [];
  for (const p of pages) {
    if (p.isRedirect || p.statusCode !== 200) continue;
    if (isPaginationArchiveURL(p.url)) continue;
    const key = normalizeUrlKey(p.url);
    if (rootURLs.has(key) || linkedTo.has(key)) continue;
    issues.push({
      code: "orphaned_page",
      severity: "warning",
      url: p.url,
      message: "No other crawled page links to this page — it is orphaned.",
      evidence: { in_sitemap: p.inSitemap },
    });
  }
  return issues;
}

/**
 * deep_crawl_depth — pages more than 4 clicks from the homepage. Depth is a
 * BFS over the internal-link graph of the crawled pages, seeded at the site
 * root. Pages unreachable within the crawled set are left unflagged (we can't
 * know their true depth from a sitemap-based crawl).
 */
export function checkCrawlDepth(pages: PageData[], siteUrl: string): Issue[] {
  const byKey = new Map<string, PageData>();
  for (const p of pages) {
    byKey.set(normalizeUrlKey(p.url), p);
    byKey.set(normalizeUrlKey(p.finalUrl), p);
  }
  let rootKey = "";
  try {
    const u = new URL(siteUrl);
    rootKey = normalizeUrlKey(`${u.protocol}//${u.host}/`);
  } catch {
    return [];
  }
  const depth = new Map<string, number>();
  const queue: string[] = [];
  if (byKey.has(rootKey)) {
    depth.set(rootKey, 0);
    queue.push(rootKey);
  } else {
    return []; // homepage not in the crawled set — can't anchor a depth BFS
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    const page = byKey.get(cur);
    if (!page) continue;
    for (const link of page.internalLinkUrls) {
      const lk = normalizeUrlKey(link);
      if (byKey.has(lk) && !depth.has(lk)) {
        depth.set(lk, d + 1);
        queue.push(lk);
      }
    }
  }
  const issues: Issue[] = [];
  const emitted = new Set<string>();
  for (const p of pages) {
    if (p.statusCode !== 200) continue;
    const key = normalizeUrlKey(p.url);
    const d = depth.get(key);
    if (d === undefined || d <= 4 || emitted.has(key)) continue;
    emitted.add(key);
    issues.push({
      code: "deep_crawl_depth",
      severity: "warning",
      url: p.url,
      message: `Page is ${d} clicks from the homepage (more than 4) — hard to discover.`,
      evidence: { depth: d },
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Sitemap / robots.txt parsing helpers (pure) — consumed by the orchestrator,
// which performs the HTTP fetches. Mirror crawlability.go + aeo_sitemap.go.
// ---------------------------------------------------------------------------

/** Does the body look like XML (first non-whitespace byte is "<", BOM-tolerant)? */
export function looksLikeXml(body: string): boolean {
  const trimmed = body.replace(/^﻿/, "").replace(/^\s+/, "");
  return trimmed.startsWith("<");
}

/** Classify a sitemap body: urlset vs index, with URL / lastmod / child counts. */
export function parseSitemapXml(body: string): {
  kind: "urlset" | "index" | "unknown";
  childLocs: string[];
  urlCount: number;
  lastmodCount: number;
} {
  if (/<sitemapindex[\s>]/i.test(body)) {
    const childLocs = (body.match(/<sitemap\b[\s\S]*?<\/sitemap>/gi) || [])
      .map((b) => {
        const m = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(b);
        return m ? m[1].trim() : "";
      })
      .filter((s) => s !== "");
    return { kind: "index", childLocs, urlCount: 0, lastmodCount: 0 };
  }
  if (/<urlset[\s>]/i.test(body)) {
    const blocks = body.match(/<url\b[\s\S]*?<\/url>/gi) || [];
    let lastmod = 0;
    for (const b of blocks) {
      if (/<lastmod>\s*[^<\s]/i.test(b)) lastmod++;
    }
    return { kind: "urlset", childLocs: [], urlCount: blocks.length, lastmodCount: lastmod };
  }
  return { kind: "unknown", childLocs: [], urlCount: 0, lastmodCount: 0 };
}

/** Extract `Sitemap:` directive URLs from a robots.txt body. */
export function extractRobotsSitemaps(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
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

/** Build `origin + path` from a site URL, falling back to the input on error. */
export function originPath(siteUrl: string, path: string): string {
  try {
    const u = new URL(siteUrl);
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return siteUrl.replace(/\/+$/, "") + path;
  }
}
