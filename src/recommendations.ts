/**
 * recommendations.ts — platform-agnostic "how it should be" guidance.
 *
 * For every issue code the auditor can emit (SEO, GEO/AEO and speed), this
 * module supplies a Recommendation: WHY it matters, the TARGET STATE ("how it
 * should be"), and an imperative, CMS-NEUTRAL recommendation of what to do.
 *
 * The prose is ported from the Seonix remediation catalog
 * (`backend/internal/scanner/remediation/profiles.json`) but deliberately
 * rewritten to be platform-agnostic: no "edit the Yoast field", no "WordPress
 * block", no plugin names. The auditor runs against ANY site (WordPress,
 * Shopify, custom, static, …) and only REPORTS problems — it never fixes
 * anything; whether and how to fix is the user's decision.
 *
 * Lookup: `recommendationFor(code)` returns the Recommendation for a known
 * code, or a sensible generic recommendation for an unmapped one.
 */

export type Severity = "error" | "warning" | "notice";

/** The category pillar an issue belongs to. */
export type IssueCategory = "seo" | "aeo" | "speed";

/** A "how it should be" recommendation attached to every emitted issue. */
export interface Recommendation {
  /** Why this matters, in plain language. */
  why: string;
  /** The desired end state — "how it should be". */
  target_state: string;
  /** Imperative, CMS-neutral guidance on what to do. */
  recommendation: string;
  /** Default severity for the code (the audit may override per instance). */
  severity: Severity;
  /** Which pillar the code rolls up to. */
  category: IssueCategory;
}

/**
 * The recommendation catalog, keyed by issue code. Severities and categories
 * mirror the Seonix scanner; the prose is rewritten platform-neutrally.
 */
const RECOMMENDATIONS: Record<string, Recommendation> = {
  // -------------------------------------------------------------------------
  // SEO — title
  // -------------------------------------------------------------------------
  title_missing: {
    category: "seo",
    severity: "warning",
    why: "The page title is the first thing a search engine reads to understand what the page is about. Without one, search engines generate an unpredictable title from the page content and the page is far less likely to rank. It is also the clickable headline in search results, so a missing title means fewer click-throughs.",
    target_state:
      "The page has a single, unique <title> of roughly 30–60 characters that clearly describes the page and leads with its primary keyword.",
    recommendation:
      "Add a descriptive <title> element to the document <head>. Make it unique per page, 30–60 characters, with the primary keyword near the start.",
  },
  title_too_long: {
    category: "seo",
    severity: "warning",
    why: "Search engines typically display only about 60 characters of a title. Anything longer is truncated with an ellipsis in results, which looks incomplete and lowers click-through. A concise title keeps the most important words visible.",
    target_state: "The <title> is 60 characters or fewer and leads with the important keywords.",
    recommendation:
      "Shorten the <title> to 60 characters or fewer while keeping the primary keyword near the beginning. If a site-wide title pattern appends a long suffix (e.g. separator + site name), trim or drop that suffix so titles fit.",
  },
  title_too_short: {
    category: "seo",
    severity: "warning",
    why: "A very short title is usually too vague to describe the page. Search engines match the title against queries, so a thin title means fewer relevant searches surface the page.",
    target_state:
      "The <title> is at least ~30 characters, clearly names the topic, and includes the key phrase users would search for.",
    recommendation:
      "Expand the <title> to at least ~30 characters with a descriptive phrase that includes the main keyword. For the home page, include the brand name and what the site does or sells.",
  },

  // -------------------------------------------------------------------------
  // SEO — meta description
  // -------------------------------------------------------------------------
  meta_description_missing: {
    category: "seo",
    severity: "error",
    why: "The meta description is the summary shown under the title in search results. It does not directly affect ranking, but it is the main text that convinces someone to click rather than choose a competitor. Without one, search engines pull random, often mid-sentence text from the page.",
    target_state:
      "The page has a unique <meta name=\"description\"> of roughly 120–160 characters that summarizes the page and reads like a mini advertisement.",
    recommendation:
      "Add a <meta name=\"description\"> to the <head> with a 120–160 character summary of what the page offers, naturally including the main keyword. Write it to earn the click.",
  },
  meta_desc_too_long: {
    category: "seo",
    severity: "warning",
    why: "Search engines show only ~155–160 characters of a meta description. A longer one is cut off mid-sentence with '…', which looks incomplete and reduces clicks.",
    target_state: "The meta description is ~160 characters or fewer and ends on a complete thought.",
    recommendation:
      "Trim the meta description to ~160 characters or fewer, keeping the key message and ending on a complete sentence.",
  },
  meta_desc_too_short: {
    category: "seo",
    severity: "warning",
    why: "A very short meta description does not give enough reason to click, and search engines may ignore it and pull a snippet from the body instead — losing your control over the result.",
    target_state:
      "The meta description is ~50–160 characters and states what the page is about, who it is for, and one reason to visit.",
    recommendation:
      "Expand the meta description to roughly 120–160 characters: cover what the page is about, who it is for, and one concrete benefit.",
  },

  // -------------------------------------------------------------------------
  // SEO — headings & images
  // -------------------------------------------------------------------------
  h1_missing: {
    category: "seo",
    severity: "warning",
    why: "Search engines use the H1 to understand what a page is about; without one the topic signal is missing and the page may rank lower. Visitors also lose an instant, visible cue about the content.",
    target_state: "The page has exactly one H1 at the top that names the page topic clearly.",
    recommendation:
      "Add a single <h1> near the top of the main content describing the page topic. First confirm the template does not already render an H1 (e.g. the page title) — if it does, do not add a second one.",
  },
  h1_multiple: {
    category: "seo",
    severity: "warning",
    why: "Several H1 tags dilute the main topic signal and confuse both crawlers and readers about which heading defines the page. A page should have exactly one H1.",
    target_state: "The page has exactly one H1 for the page topic; all other section headings are H2 or lower.",
    recommendation:
      "Keep the single H1 that best describes the whole page and demote the rest to H2 (or the level that fits their place in the outline). Watch for a template that adds its own H1 in addition to in-content ones.",
  },
  images_missing_alt: {
    category: "seo",
    severity: "warning",
    why: "Screen readers and search engines rely on alt text to understand what an image shows. Images without it rank worse in image search and break the experience for assistive-technology users.",
    target_state:
      "Every content image has a short, accurate alt attribute describing what it shows; genuinely decorative images use an intentionally empty alt=\"\".",
    recommendation:
      "Add a concise, factual alt attribute (1–2 short phrases, no keyword stuffing) to each meaningful <img>. For purely decorative images, set alt=\"\" deliberately so assistive tech skips them.",
  },
  heading_emoji: {
    category: "seo",
    severity: "notice",
    why: "An emoji at the start of a heading can appear in search snippets and look unpolished, and screen readers announce the emoji description aloud, disrupting the reading flow.",
    target_state: "Headings start with words, not emoji.",
    recommendation:
      "Remove the leading emoji from the heading text. If a visual accent is wanted, place it within body text below the heading instead.",
  },
  heading_too_long_likely_paragraph: {
    category: "seo",
    severity: "notice",
    why: "Headings are meant to be short labels for the section below them. A heading that reads like a full sentence or paragraph confuses crawlers about page structure and makes the page harder to scan.",
    target_state: "Each heading is a brief label (typically under ~70 characters); full sentences live in paragraphs.",
    recommendation:
      "Shorten the heading to a brief descriptive label and move the full sentence into a normal paragraph beneath it.",
  },
  broken_heading_hierarchy: {
    category: "seo",
    severity: "notice",
    why: "Headings form the page outline. Skipping a level (e.g. H2 straight to H4) makes that outline harder to follow for screen readers and crawlers that rely on it to understand structure.",
    target_state: "Heading levels increase by at most one step at a time (H1 → H2 → H3), with no skipped levels.",
    recommendation:
      "Change the heading after the jump to the next sequential level so no level is skipped (e.g. make the H4 an H3). Repeat for every skip on the page.",
  },
  heading_before_h1: {
    category: "seo",
    severity: "warning",
    why: "The H1 should be the first and highest heading on the page. When an H2 or H3 appears before the H1, the outline is logically inverted, which can confuse users and search engines about the page topic.",
    target_state: "The H1 is the first heading encountered when reading the page top to bottom.",
    recommendation:
      "Move the H1 above any heading that currently precedes it, or demote those earlier headings to a level that reflects their role (or convert label-like text to styled paragraphs).",
  },

  // -------------------------------------------------------------------------
  // Technical (rolled up under SEO pillar here)
  // -------------------------------------------------------------------------
  ssl_mixed_content: {
    category: "seo",
    severity: "warning",
    why: "The page is served over HTTPS but loads some resources over insecure HTTP. Browsers warn about or block those resources, breaking the page, and HTTPS is a trust signal that mixed content undermines.",
    target_state: "Every resource (images, scripts, styles, links) on an HTTPS page is itself loaded over HTTPS.",
    recommendation:
      "Update each http:// resource reference to https:// (or to a protocol-relative/same-origin URL). For third-party resources that have no HTTPS version, replace or remove them.",
  },
  canonical_mismatch: {
    category: "seo",
    severity: "warning",
    why: "Search engines use the canonical tag to decide which URL to index and rank. When it points to a different address than the one crawled, they may ignore the page or split its ranking signals between URLs.",
    target_state: "The canonical URL exactly matches the page's own final URL (scheme, host, path, trailing slash).",
    recommendation:
      "Set the <link rel=\"canonical\"> to the page's own final URL, with no stray trailing slash, query string, or http/https mismatch — unless the page is intentionally a duplicate of another canonical.",
  },
  missing_viewport: {
    category: "seo",
    severity: "warning",
    why: "The viewport meta tag tells mobile browsers how to scale the page. Without it, phones render a shrunken desktop layout with tiny text and untappable buttons, and mobile-friendliness is an important quality signal.",
    target_state: "The page declares <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> in its <head>.",
    recommendation:
      "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> to the document <head> (usually in the site template/header).",
  },

  // -------------------------------------------------------------------------
  // SEO / social — Open Graph
  // -------------------------------------------------------------------------
  missing_og_tags: {
    category: "seo",
    severity: "notice",
    why: "Open Graph (og:*) meta tags tell social networks, messaging apps, and AI-powered link previews what the page is about. Without them, shares look broken — the wrong title or image may appear — and the content gets far less engagement when distributed.",
    target_state:
      "The page declares the core Open Graph tags: og:title, og:description, og:type, og:url, and an og:image (ideally ~1200×630).",
    recommendation:
      "Add the core og:* meta tags to the <head>: og:title, og:description, og:url, og:type, and og:image. Provide a social image of at least 1200×630 px.",
  },
  og_image_missing: {
    category: "seo",
    severity: "notice",
    why: "When a page is shared on social media or a chat app, platforms look for og:image to build a preview card. Without it the share looks blank or pulls a random image, sharply reducing click-through.",
    target_state: "The page declares an og:image of at least ~1200×630 px.",
    recommendation:
      "Add an <meta property=\"og:image\"> pointing to a representative image of at least 1200×630 px (and ideally og:image:width / og:image:height).",
  },

  // -------------------------------------------------------------------------
  // AEO / GEO — structured data
  // -------------------------------------------------------------------------
  missing_structured_data: {
    category: "aeo",
    severity: "notice",
    why: "AI assistants and search engines read structured data (JSON-LD) to understand who you are, what the page is about, and whether to cite it. Without it the page is far less legible to AI-powered answer engines.",
    target_state:
      "The page includes a valid JSON-LD block of the schema.org type that fits it (e.g. Article for posts, FAQPage for Q&A, LocalBusiness for a business home page).",
    recommendation:
      "Add a <script type=\"application/ld+json\"> block with the appropriate schema.org type. At minimum include @context, @type, headline/name, url, and datePublished for articles. Validate with a structured-data testing tool.",
  },
  invalid_structured_data: {
    category: "aeo",
    severity: "warning",
    why: "Broken JSON-LD is silently ignored by search engines and AI crawlers. The page appears to have structured data, but it provides no benefit because the markup cannot be parsed.",
    target_state: "Every JSON-LD block on the page is syntactically valid JSON and parses cleanly.",
    recommendation:
      "Fix the JSON syntax error (commonly a missing comma, an unclosed quote, or a trailing comma before a closing brace), then re-validate the block with a JSON / structured-data validator.",
  },
  aeo_jsonld_author_not_person: {
    category: "aeo",
    severity: "notice",
    why: "When an article's author is a plain string or an untyped/empty object instead of a Person entity with a name and profile URL, AI assistants cannot verify who wrote the content. Named, verifiable authors strengthen trust signals over time.",
    target_state:
      "The article's author is a Person object with a name and a url (and ideally a sameAs link to a known profile).",
    recommendation:
      "Express the author as { \"@type\": \"Person\", \"name\": \"…\", \"url\": \"…\" } in the JSON-LD (resolving an @id reference to a real Person node also counts). Add sameAs to a professional profile for a stronger signal. An empty author usually means the underlying content has no real author assigned — assign one.",
  },
  aeo_jsonld_dates_missing: {
    category: "aeo",
    severity: "notice",
    why: "AI assistants filter content by freshness. Without datePublished (and dateModified) in the structured data, they cannot tell when the article was written and may skip it for time-sensitive queries.",
    target_state: "The article's JSON-LD includes datePublished (and dateModified for updates) in ISO-8601 form.",
    recommendation:
      "Add datePublished (YYYY-MM-DD) to the article JSON-LD, and dateModified for the last meaningful update. Ensure the schema generator is enabled for this content type.",
  },
  aeo_ai_meta_tag_restrictive: {
    category: "aeo",
    severity: "warning",
    why: "Directives such as noai, noimageai, or nosnippet tell AI crawlers not to index or use the page. If unintentional, they silently exclude the page from AI-generated answers.",
    target_state:
      "The page allows AI indexing (no noai / noimageai / nosnippet) unless those restrictions are a deliberate choice.",
    recommendation:
      "Review the page's robots meta tag and X-Robots-Tag header. If noai / noimageai / nosnippet were added unintentionally, remove them (use index, follow). Keep them only if the restriction is deliberate.",
  },

  // -------------------------------------------------------------------------
  // AEO / GEO — site-level (llms.txt, robots.txt)
  // -------------------------------------------------------------------------
  llms_txt_missing: {
    category: "aeo",
    severity: "notice",
    why: "llms.txt is an emerging convention for giving AI assistants a brief, curated summary of a site and its key pages. It is not yet consistently used by major systems, but adding it is a simple, future-friendly step.",
    target_state:
      "The site serves a valid /llms.txt: Markdown starting with a # title, an optional summary, and sections of Markdown links to key pages.",
    recommendation:
      "Publish a /llms.txt at the site root. Start with a level-1 heading (# Site Name), add a 2–4 sentence summary, then list the most important pages as Markdown links.",
  },
  aeo_llms_txt_invalid: {
    category: "aeo",
    severity: "warning",
    why: "A malformed /llms.txt may be ignored or misread by the AI tools that support the convention, wasting the effort of having published it.",
    target_state:
      "/llms.txt is valid Markdown per llmstxt.org: a level-1 # heading, an optional blockquote summary, and list items in the form - [Label](https://url).",
    recommendation:
      "Fix /llms.txt to follow the llmstxt.org spec: ensure it starts with a # heading, is at least ~100 characters, and that every link is a proper Markdown link - [Label](https://url).",
  },
  aeo_robots_blocks_ai_bot: {
    category: "aeo",
    severity: "error",
    why: "Blocking AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …) in robots.txt means those services cannot read the site and will never cite it in AI-generated answers — cutting off a growing visibility channel.",
    target_state:
      "robots.txt allows the AI crawlers you want to be cited by (or only blocks them where that is a deliberate choice).",
    recommendation:
      "In robots.txt, remove or relax the Disallow rules for the AI user-agents you want to reach (or change them to Allow: /). Keep the block only if excluding those bots is intentional.",
  },

  // -------------------------------------------------------------------------
  // SPEED — per-page (Lighthouse / Core Web Vitals + HTML heuristics)
  // -------------------------------------------------------------------------
  speed_low_score: {
    category: "speed",
    severity: "error",
    why: "A low overall performance score means visitors on an average phone wait many seconds for the page; many leave before it finishes, and slow pages rank lower.",
    target_state: "The page scores ~90+ on a mobile performance test and feels close to instant.",
    recommendation:
      "Tackle the page's specific speed problems in order of estimated savings — start with the largest (render-blocking resources, images, server response) — then re-measure.",
  },
  speed_render_blocking: {
    category: "speed",
    severity: "warning",
    why: "The browser must download and run render-blocking scripts and stylesheets before it can show anything. On mobile this often adds whole seconds of blank screen — the most common reason a page feels slow.",
    target_state:
      "Critical CSS is inlined and non-critical JavaScript is deferred, so the page paints without waiting on blocking resources.",
    recommendation:
      "Add async or defer to non-critical <script> tags, and inline or preload critical CSS while deferring the rest. Move third-party scripts out of the critical path.",
  },
  speed_unoptimized_images: {
    category: "speed",
    severity: "warning",
    why: "Oversized or uncompressed images are usually the heaviest files on a page. Serving them compressed, correctly sized, and in modern formats removes most of that weight with no visible quality loss.",
    target_state:
      "Images are compressed, sized to their displayed dimensions, and delivered in modern formats (WebP/AVIF).",
    recommendation:
      "Compress images, generate responsive sizes (srcset) matched to display dimensions, and serve WebP/AVIF. A build step or image CDN can do this automatically.",
  },
  speed_unused_javascript: {
    category: "speed",
    severity: "warning",
    why: "Scripts that ship to every visitor but are never executed waste download and parse time, delaying the moment the page becomes usable.",
    target_state: "The page loads only the JavaScript it actually needs.",
    recommendation:
      "Remove or code-split JavaScript the page doesn't use, drop unneeded third-party scripts, and lazy-load widgets (analytics, chat) so they load after the main content.",
  },
  speed_unused_css: {
    category: "speed",
    severity: "notice",
    why: "Themes and component libraries ship one large stylesheet covering every feature. The page downloads all of it but uses a fraction, wasting transfer and slowing the first paint.",
    target_state: "The page ships close to only the CSS it uses.",
    recommendation:
      "Remove or split unused CSS (PurgeCSS-style tooling, critical-CSS extraction, or lighter components), then verify the layout still renders correctly.",
  },
  speed_text_compression: {
    category: "speed",
    severity: "warning",
    why: "HTML, CSS, and JavaScript compress extremely well — GZIP or Brotli typically shrinks them 60–80%. Without compression every visitor downloads several times more data than necessary.",
    target_state: "Text resources (HTML/CSS/JS) are served with GZIP or Brotli compression.",
    recommendation:
      "Enable GZIP/Brotli compression for text responses at the server or CDN. It is usually a one-line server setting and is on by default on most CDNs.",
  },
  speed_slow_server_response: {
    category: "speed",
    severity: "warning",
    why: "Time-to-first-byte (TTFB) is the delay before the server even starts answering. Nothing can render during that time, so a slow backend slows every page regardless of how light the content is.",
    target_state: "The server's time-to-first-byte is comfortably under ~600 ms.",
    recommendation:
      "Add page/full-page caching so repeat requests skip heavy processing, put a CDN in front, and optimize slow database queries. If TTFB stays high with caching on, move to faster hosting.",
  },
  speed_main_thread_work: {
    category: "speed",
    severity: "notice",
    why: "After downloading, JavaScript still has to be parsed and executed. While the main thread is busy, the page cannot react to taps or typing — it looks loaded but feels frozen.",
    target_state: "Main-thread JavaScript work is light enough that the page becomes interactive quickly.",
    recommendation:
      "Reduce the amount of JavaScript that runs on load: trim or defer heavy scripts and third-party widgets, break up long tasks, and load interactive embeds only on user interaction.",
  },
  speed_large_dom: {
    category: "speed",
    severity: "notice",
    why: "Browsers slow down when a page has thousands of HTML elements — every style recalculation has to touch all of them. Huge DOMs usually come from page builders, mega-menus, and very long lists.",
    target_state: "The page keeps its DOM modest (well under ~1,500 elements) with shallow nesting.",
    recommendation:
      "Simplify the markup: fewer nested wrappers, shorter menus and lists, and pagination or virtualization for very long content.",
  },
  speed_offscreen_images: {
    category: "speed",
    severity: "warning",
    why: "Images far below the fold that load immediately compete for bandwidth with the content the visitor actually sees first, delaying the initial render.",
    target_state: "Below-the-fold images are lazy-loaded; only above-the-fold imagery loads eagerly.",
    recommendation:
      "Add loading=\"lazy\" to below-the-fold <img> elements (and avoid lazy-loading the main above-the-fold image). Confirm a script or slider isn't overriding native lazy-loading.",
  },
  speed_efficient_cache: {
    category: "speed",
    severity: "notice",
    why: "Static assets served with a short or missing cache lifetime force returning visitors to re-download files that never changed.",
    target_state: "Static assets (images, scripts, styles) are served with a long cache lifetime (30+ days).",
    recommendation:
      "Set long Cache-Control max-age (with fingerprinted filenames for cache-busting) on static assets, via the server or CDN.",
  },

  // -------------------------------------------------------------------------
  // SPEED — extra heuristic-only codes (no PSI equivalent)
  // -------------------------------------------------------------------------
  speed_render_blocking_heuristic: {
    category: "speed",
    severity: "warning",
    why: "Scripts without async/defer and stylesheets in the <head> block the browser from painting until they download and run. A high count in the document head is a strong signal the page will feel slow on mobile before any lab test is run.",
    target_state:
      "The <head> carries few render-blocking resources: non-critical scripts use async/defer and only critical CSS is loaded synchronously.",
    recommendation:
      "Add async or defer to non-critical <script> tags in the <head>, and inline or preload only critical CSS while deferring the rest.",
  },
  speed_image_dimensions_missing: {
    category: "speed",
    severity: "warning",
    why: "Images without explicit width and height attributes have no reserved space, so the page reflows as each one loads — causing layout shift (poor CLS) that makes the page feel janky and can demote it.",
    target_state: "Every <img> declares width and height (or an equivalent aspect-ratio) so its box is reserved before it loads.",
    recommendation:
      "Add width and height attributes (or a CSS aspect-ratio) to each <img> so the browser can reserve space and avoid layout shift.",
  },
  speed_large_inline_resource: {
    category: "speed",
    severity: "notice",
    why: "Very large inline <style> or <script> blocks bloat the HTML document itself, so they cannot be cached separately and delay the first paint on every visit.",
    target_state: "Inline <style>/<script> blocks are small (critical-path only); bulk CSS/JS lives in cacheable external files.",
    recommendation:
      "Move large inline styles and scripts into external, cacheable files, keeping inline blocks limited to small critical-path snippets.",
  },
  speed_heavy_page_weight: {
    category: "speed",
    severity: "notice",
    why: "A large HTML document (before images and other assets are even counted) means more bytes to download and parse, which is felt most on slow mobile connections.",
    target_state: "The HTML document stays lean so it downloads and parses quickly on mobile.",
    recommendation:
      "Reduce the HTML payload: trim inline assets, remove dead markup and duplicated content, and lazy-load below-the-fold sections.",
  },
};

/** A generic fallback for any code without a dedicated profile. */
function genericRecommendation(category: IssueCategory, severity: Severity): Recommendation {
  const pillar =
    category === "speed" ? "page performance" : category === "aeo" ? "AI-search (GEO/AEO) visibility" : "search-engine (SEO) visibility";
  return {
    category,
    severity,
    why: `This issue affects the page's ${pillar}.`,
    target_state: "The page follows the established best practice for this check.",
    recommendation:
      "Review the evidence for this finding and bring the page in line with the recommended best practice. This audit reports the problem only; deciding whether and how to fix it is up to you.",
  };
}

/**
 * Return the recommendation for an issue code. Unknown codes get a sensible
 * generic recommendation in the requested category/severity (defaults: seo /
 * notice) so every emitted issue always carries why / target_state /
 * recommendation.
 */
export function recommendationFor(
  code: string,
  fallback?: { category?: IssueCategory; severity?: Severity },
): Recommendation {
  const hit = RECOMMENDATIONS[code];
  if (hit) return hit;
  return genericRecommendation(fallback?.category ?? "seo", fallback?.severity ?? "notice");
}

/** Expose the full catalog (used by tests / introspection). */
export function allRecommendations(): Readonly<Record<string, Recommendation>> {
  return RECOMMENDATIONS;
}
