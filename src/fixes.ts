/**
 * fixes.ts — the safe-fix ADVISOR layer (read-only).
 *
 * Turns audit findings into concrete, minimal fix proposals and lets a client
 * DRY-RUN them against the page's HTML to prove the change is localized before
 * anyone writes anything. Nothing here mutates a live site — `proposeFixes`
 * and `previewFix` are pure and platform-agnostic. Writing the change (and the
 * pixel-level visual-regression gate that needs a headless render) is a
 * separate, opt-in applier layer (WordPress first) — see
 * src/extras/wordpress-fixers.ts and docs/the spec.
 *
 * Design (mirrors _workspace/mcp-safe-fix-engine-spec.md, build order #1–#2):
 *   proposeFixes(issues, page) → FixProposal[]   // concrete edit + classification
 *   previewFix(fix, freshHtml) → PreviewResult    // static dry-run + structural gate
 *
 * The static gate proves the edit touches ONLY its intended region (localized),
 * is a no-op if already applied (idempotent), or can't be uniquely located
 * (ambiguous → blocked). It deliberately does NOT claim pixel-perfect visual
 * safety — that requires rendering and belongs to the (future) apply layer.
 */

import { decodeEntities, isLeadingEmoji, type Issue, type PageData } from "./audit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FixFamily =
  | "meta-inject" // add a tag to <head> (viewport, OG, …)
  | "content-replace" // rewrite text/markup in place (decode title, strip emoji, retag, http→https)
  | "needs-value" // mechanical edit, but a human/AI must supply the value (alt text, dates)
  | "manual" // a content/structure decision — guidance only, no auto-edit
  | "infra"; // server / robots.txt / sitemap / CDN — not a page-markup edit

export type Visibility = "visible" | "invisible" | "unknown";

/** A declarative edit the previewer can apply statically and an applier can execute. */
export interface FixEdit {
  type:
    | "insert-head"
    | "replace-strings"
    | "decode-title"
    | "strip-heading-emoji"
    | "retag-heading"
    | "set-attribute"
    | "inject-jsonld-field"
    | "manual"
    | "infra";
  /** insert-head: the markup to add, and a marker substring used for idempotency. */
  snippet?: string;
  marker?: string;
  /** replace-strings: literal before→after pairs (e.g. http→https). */
  replacements?: { before: string; after: string }[];
  /** strip-heading-emoji: the leading emoji to remove. */
  emoji?: string;
  /** retag-heading: locate <hLevel>text</hLevel> and change its tag to newLevel. */
  level?: number;
  newLevel?: number;
  text?: string;
  /** set-attribute / inject-jsonld-field: where + what (value supplied by human/AI). */
  target?: string;
  attribute?: string;
  field?: string;
  /** infra: where the fix actually lives (server, robots.txt, CDN, …). */
  where?: string;
}

export interface FixProposal {
  fixId: string;
  code: string;
  url: string;
  family: FixFamily;
  visibility: Visibility;
  /** Plain-language description of what the fix changes. */
  whatChanges: string;
  /** Issue codes this fix is expected to clear. */
  clears: string[];
  edit: FixEdit;
  /** Why this is safe / what to watch for. */
  safetyNotes: string[];
}

export type GateStatus = "pass" | "idempotent" | "blocked" | "manual";

export interface PreviewResult {
  fixId: string;
  code: string;
  url: string;
  family: FixFamily;
  visibility: Visibility;
  whatChanges: string;
  clears: string[];
  /** Result of the static dry-run safety gate. */
  regressionGate: GateStatus;
  gateReason: string;
  /** before/after of the affected region (for content edits), or a description. */
  before?: string;
  after?: string;
  /** How many places the edit matched in the fetched HTML. */
  occurrences?: number;
  safetyNotes: string[];
  /** True when this fix still needs a human/AI-supplied value before applying. */
  needsValue?: boolean;
}

// ---------------------------------------------------------------------------
// Shared safety notes (the lessons the engine exists to enforce)
// ---------------------------------------------------------------------------

const NOTE_IDEMPOTENT = "Idempotent — applying it again is a no-op.";
const NOTE_HEAD_ONLY = "Inserted into <head> only; the page body is untouched.";
const NOTE_LOCALIZED = "Edits only this element; sibling and parent attributes are left untouched.";
const NOTE_WP_SLASH =
  "If applied through a WordPress block builder, re-slash the content (wp_slash) and regenerate any per-block CSS before saving — a missing slash corrupts block JSON (this is the failure this engine exists to prevent).";

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTagsLocal(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function insertIntoHead(html: string, snippet: string): string {
  const m = /<head[^>]*>/i.exec(html);
  if (m) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + "\n    " + snippet + html.slice(at);
  }
  const h = /<html[^>]*>/i.exec(html);
  if (h) {
    const at = h.index + h[0].length;
    return html.slice(0, at) + "\n<head>\n    " + snippet + "\n</head>" + html.slice(at);
  }
  return snippet + "\n" + html;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------

let counter = 0;
function mkId(code: string, url: string): string {
  // Deterministic-ish per call sequence; unique within one propose_fixes run.
  counter += 1;
  return `fix_${code}_${counter}`;
}

/**
 * Build fix proposals for a page's issues. `page` supplies values for meta
 * inserts (og:title from <title>, etc.). Site-level issues (robots/sitemap)
 * also get infra-level guidance proposals. Read-only — no writes.
 */
export function proposeFixes(issues: Issue[], page: PageData | null): FixProposal[] {
  const out: FixProposal[] = [];
  for (const issue of issues) {
    const p = buildProposal(issue, page);
    if (p) out.push(p);
  }
  return out;
}

function buildProposal(issue: Issue, page: PageData | null): FixProposal | null {
  const { code, url } = issue;
  const ev = issue.evidence ?? {};
  const base = (family: FixFamily, visibility: Visibility, whatChanges: string, edit: FixEdit, safetyNotes: string[], clears = [code]): FixProposal => ({
    fixId: mkId(code, url),
    code,
    url,
    family,
    visibility,
    whatChanges,
    clears,
    edit,
    safetyNotes,
  });

  switch (code) {
    // --- meta-inject (deterministic, invisible) -------------------------------
    case "missing_viewport":
      return base(
        "meta-inject",
        "invisible",
        "Adds the mobile viewport meta tag to <head>. No visible change on desktop; mobile pages stop rendering a shrunken desktop layout.",
        { type: "insert-head", marker: 'name="viewport"', snippet: '<meta name="viewport" content="width=device-width, initial-scale=1">' },
        [NOTE_HEAD_ONLY, NOTE_IDEMPOTENT],
      );

    case "missing_og_tags":
    case "aeo_og_incomplete": {
      const snippet = buildOgSnippet(page);
      if (!snippet) return manualProposal(issue, "No <title>/description available to derive Open Graph tags from — set them once the page has a title and description.");
      const needsImage = !page || page.ogImage === "";
      return base(
        "meta-inject",
        "invisible",
        `Adds the missing Open Graph / Twitter card tags to <head>${needsImage ? " (you still need to add an og:image — there is no source image to derive)" : ""}.`,
        { type: "insert-head", marker: 'property="og:title"', snippet },
        [NOTE_HEAD_ONLY, NOTE_IDEMPOTENT, "og:title/description/url are derived from the page's existing <title>, meta description and URL — review them before applying."],
        code === "aeo_og_incomplete" ? [code, "missing_og_tags"] : [code],
      );
    }

    case "og_image_missing":
      return base(
        "needs-value",
        "invisible",
        "Adds an og:image to <head> for social/link previews. You must supply the image URL (ideally 1200×630).",
        { type: "set-attribute", target: "<head>", field: "og:image", attribute: "content" },
        [NOTE_HEAD_ONLY, "Pick a representative image at least 1200×630 px."],
      );

    // --- content-replace (deterministic) -------------------------------------
    case "ssl_mixed_content": {
      const examples = Array.isArray(ev.examples) ? (ev.examples as string[]) : [];
      const replacements = examples
        .filter((u) => typeof u === "string" && u.startsWith("http://"))
        .map((u) => ({ before: u, after: "https://" + u.slice("http://".length) }));
      if (replacements.length === 0) return manualProposal(issue, "Rewrite each http:// resource URL to https:// (the audit captured the offending URLs in evidence).");
      return base(
        "content-replace",
        "invisible",
        `Rewrites ${replacements.length} insecure http:// resource URL(s) to https://. Usually invisible, but a resource that was being blocked as mixed content may start to appear once it loads.`,
        { type: "replace-strings", replacements },
        [NOTE_LOCALIZED, NOTE_IDEMPOTENT, "Confirm each resource is actually reachable over https:// (some third-party hosts have no TLS version)."],
      );
    }

    case "title_html_entities":
      return base(
        "content-replace",
        "invisible",
        "Decodes the HTML entities in the <title> (e.g. &amp; → &). Changes the browser-tab and search-result title text; the page body is unchanged.",
        { type: "decode-title" },
        [NOTE_LOCALIZED, NOTE_IDEMPOTENT, "This fixes a double-encoding bug; verify the title reads correctly afterwards."],
      );

    case "heading_emoji": {
      const emoji = typeof ev.leading_emoji === "string" ? (ev.leading_emoji as string) : "";
      if (emoji === "") return manualProposal(issue, "Remove the leading emoji from the heading text.");
      return base(
        "content-replace",
        "visible",
        `Removes the leading "${emoji}" from the heading. This is a visible text change.`,
        { type: "strip-heading-emoji", emoji },
        [NOTE_LOCALIZED, NOTE_IDEMPOTENT, NOTE_WP_SLASH],
      );
    }

    case "broken_heading_hierarchy": {
      const retag = buildRetagEdit(ev);
      if (!retag) return manualProposal(issue, "Change the heading after the level jump to the next sequential level so no level is skipped.");
      return base(
        "content-replace",
        "invisible",
        `Retags the H${retag.level} heading "${retag.text.slice(0, 50)}" to H${retag.newLevel} so the outline has no skipped level. The tag changes but the text and CSS class are preserved, so the look is unchanged when the heading is styled by class.`,
        { type: "retag-heading", level: retag.level, newLevel: retag.newLevel, text: retag.text },
        [NOTE_LOCALIZED, NOTE_IDEMPOTENT, NOTE_WP_SLASH, "If the heading is styled by its tag (not a class), retagging can change its size — review the rendered page."],
      );
    }

    // --- needs-value ----------------------------------------------------------
    case "images_missing_alt": {
      const examples = Array.isArray(ev.examples) ? (ev.examples as { src?: string; outer_html?: string }[]) : [];
      const first = examples[0];
      return base(
        "needs-value",
        "invisible",
        `Adds a short, accurate alt attribute to ${typeof ev.images_without_alt === "number" ? ev.images_without_alt : "the"} image(s). The alt text must be written by a human or an image-aware model — it cannot be derived from the HTML alone.`,
        { type: "set-attribute", target: first?.outer_html ?? first?.src ?? "<img>", attribute: "alt" },
        [NOTE_LOCALIZED, "Write a concise factual description (1–2 phrases). Use alt=\"\" only for genuinely decorative images."],
      );
    }

    case "aeo_jsonld_dates_missing":
      return base(
        "needs-value",
        "invisible",
        "Adds datePublished (ISO 8601) to the Article JSON-LD. The real publish date must be supplied (usually the CMS already knows it).",
        { type: "inject-jsonld-field", field: "datePublished" },
        [NOTE_IDEMPOTENT, "Use the genuine publication date; only set dateModified on real content changes."],
      );

    // --- infra (server / robots / sitemap / CDN / speed) ---------------------
    case "aeo_robots_blocks_ai_bot":
    case "robots_blocks_all":
    case "robots_blocks_sitemap_path":
      return infraProposal(issue, "robots.txt", "Edit robots.txt — note that a CDN (e.g. Cloudflare's AI-crawler controls) can inject or override robots rules, so check the edge as well as the origin file.");
    case "robots_missing":
      return infraProposal(issue, "robots.txt", "Publish a /robots.txt at the site root with at least a Sitemap: directive.");
    case "sitemap_unreachable":
    case "sitemap_invalid_xml":
    case "sitemap_empty":
    case "sitemap_index_children_failed":
    case "sitemap_not_declared_in_robots":
    case "aeo_sitemap_lastmod_missing":
      return infraProposal(issue, "sitemap", "Fix the sitemap output / generator settings (most CMS sitemap plugins expose the relevant toggle).");
    case "llms_txt_missing":
    case "aeo_llms_txt_invalid":
      return infraProposal(issue, "/llms.txt", "Publish or regenerate /llms.txt: a # title, a short summary, and Markdown links to key pages.");
    case "http_4xx":
    case "http_5xx":
    case "broken_redirect":
    case "redirect_loop":
    case "too_many_redirects":
      return infraProposal(issue, "server", "Resolve at the server / redirect-rule level.");
    default:
      break;
  }

  // Speed PSI/heuristic codes and everything else → infra or manual guidance.
  if (code.startsWith("speed_")) return infraProposal(issue, "performance", "A performance optimization (caching, image compression, deferring scripts) — applied at the server, build, or CDN, not in page markup.");

  // Remaining fixable-but-not-mechanical SEO/AEO issues → manual guidance.
  return manualProposal(issue, "");
}

function manualProposal(issue: Issue, hint: string): FixProposal {
  return {
    fixId: mkId(issue.code, issue.url),
    code: issue.code,
    url: issue.url,
    family: "manual",
    visibility: "unknown",
    whatChanges: hint || "This needs a content or structure decision — there is no single safe mechanical edit. Follow the audit's recommendation for this issue.",
    clears: [issue.code],
    edit: { type: "manual" },
    safetyNotes: ["Review the page in context before changing it; the right fix depends on the content."],
  };
}

function infraProposal(issue: Issue, where: string, hint: string): FixProposal {
  return {
    fixId: mkId(issue.code, issue.url),
    code: issue.code,
    url: issue.url,
    family: "infra",
    visibility: "invisible",
    whatChanges: hint,
    clears: [issue.code],
    edit: { type: "infra", where },
    safetyNotes: [`This fix lives in ${where}, not in the page's HTML — it cannot be previewed as a markup diff.`],
  };
}

/** Build the og:* + twitter:card snippet from the page's existing data. */
function buildOgSnippet(page: PageData | null): string | null {
  if (!page) return null;
  const lines: string[] = [];
  if (!page.hasOgTitle && page.title) lines.push(`<meta property="og:title" content="${escapeAttr(page.title)}">`);
  if (!page.hasOgDescription && page.metaDescription) lines.push(`<meta property="og:description" content="${escapeAttr(page.metaDescription)}">`);
  if (!page.hasOgUrl) lines.push(`<meta property="og:url" content="${escapeAttr(page.finalUrl)}">`);
  lines.push(`<meta property="og:type" content="website">`);
  if (!page.hasTwitterCard) lines.push(`<meta name="twitter:card" content="summary_large_image">`);
  return lines.length > 0 ? lines.join("\n    ") : null;
}

/** Derive a retag edit (level → newLevel + heading text) from broken-hierarchy evidence. */
function buildRetagEdit(ev: Record<string, unknown>): { level: number; newLevel: number; text: string } | null {
  const expected = typeof ev.expected_level === "number" ? (ev.expected_level as number) : 0;
  const actual = typeof ev.actual_level === "number" ? (ev.actual_level as number) : 0;
  if (expected < 1 || actual < 1 || actual <= expected) return null;
  const after = typeof ev.after_heading === "string" ? (ev.after_heading as string) : "";
  const outline = Array.isArray(ev.heading_outline) ? (ev.heading_outline as { level: number; text: string }[]) : [];
  // The offending heading is the first one at `actual` level appearing after `after`.
  let seenAfter = after === "";
  for (const h of outline) {
    if (!seenAfter) {
      if (h.text === after) seenAfter = true;
      continue;
    }
    if (h.level === actual) return { level: actual, newLevel: expected, text: h.text };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Static preview / regression gate
// ---------------------------------------------------------------------------

/**
 * Dry-run a fix against freshly-fetched HTML, statically. Proves the edit is
 * localized / idempotent / not ambiguous WITHOUT rendering or writing. Returns
 * a regression-gate verdict the client shows the user before any apply.
 *
 * NOTE: this is a STRUCTURAL gate (does the edit touch only its region?). It is
 * not a pixel/computed-style gate — that needs a headless render and belongs to
 * the apply layer. needs-value / manual / infra fixes are not auto-previewable.
 */
export function previewFix(fix: FixProposal, html: string): PreviewResult {
  const r: PreviewResult = {
    fixId: fix.fixId,
    code: fix.code,
    url: fix.url,
    family: fix.family,
    visibility: fix.visibility,
    whatChanges: fix.whatChanges,
    clears: fix.clears,
    regressionGate: "manual",
    gateReason: "",
    safetyNotes: fix.safetyNotes,
  };

  switch (fix.edit.type) {
    case "insert-head": {
      const marker = fix.edit.marker ?? "";
      if (marker && html.includes(marker)) {
        r.regressionGate = "idempotent";
        r.gateReason = `A tag matching '${marker}' is already present — applying would be a no-op.`;
        return r;
      }
      r.before = "(no such tag in <head>)";
      r.after = fix.edit.snippet ?? "";
      r.regressionGate = /<head[^>]*>/i.test(html) ? "pass" : "pass";
      r.gateReason = "Inserts into <head>; the page body is unchanged. Localized and safe.";
      return r;
    }

    case "replace-strings": {
      const reps = fix.edit.replacements ?? [];
      let applied = 0;
      let firstBefore = "";
      let firstAfter = "";
      for (const rep of reps) {
        const occ = countOccurrences(html, rep.before);
        if (occ > 0) {
          applied += occ;
          if (firstBefore === "") {
            firstBefore = rep.before;
            firstAfter = rep.after;
          }
        }
      }
      r.occurrences = applied;
      if (applied === 0) {
        r.regressionGate = "idempotent";
        r.gateReason = "None of the target strings are present — already fixed, or the page changed.";
        return r;
      }
      r.before = firstBefore;
      r.after = firstAfter;
      r.regressionGate = "pass";
      r.gateReason = `Replaces ${applied} exact-string occurrence(s); nothing else in the document is touched.`;
      return r;
    }

    case "decode-title": {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      if (!m) {
        r.regressionGate = "blocked";
        r.gateReason = "No <title> element found to decode.";
        return r;
      }
      const raw = m[1];
      // Un-double-encode ONE level: "&amp;amp;" → "&amp;", "&amp;quot;" → "&quot;".
      // A correctly single-encoded "&amp; Bar" is left intact (idempotent + valid HTML).
      const fixed = raw.replace(/&amp;([a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, "&$1");
      if (fixed === raw) {
        r.regressionGate = "idempotent";
        r.gateReason = "The <title> has no double-encoded entities — already clean.";
        return r;
      }
      r.before = raw.trim();
      r.after = fixed.trim();
      r.occurrences = 1;
      r.regressionGate = "pass";
      r.gateReason = "Removes one level of HTML-entity encoding from the <title> only; the rest of the document is unchanged.";
      return r;
    }

    case "strip-heading-emoji": {
      const emoji = fix.edit.emoji ?? "";
      if (emoji === "") {
        r.regressionGate = "blocked";
        r.gateReason = "No emoji specified.";
        return r;
      }
      // Match the emoji (with optional VS16) right after a heading open tag.
      const re = new RegExp(`(<h[1-6]\\b[^>]*>\\s*)${escapeRegex(emoji)}\\uFE0F?\\s?`, "g");
      const matches = html.match(re);
      const occ = matches ? matches.length : 0;
      if (occ === 0) {
        r.regressionGate = "idempotent";
        r.gateReason = "No heading starts with that emoji — already removed.";
        return r;
      }
      r.occurrences = occ;
      r.before = `${emoji} <heading text>`;
      r.after = `<heading text>`;
      r.regressionGate = "pass";
      r.gateReason = `Strips the leading emoji from ${occ} heading(s); the heading tag, class and remaining text are preserved.`;
      return r;
    }

    case "retag-heading": {
      const level = fix.edit.level ?? 0;
      const newLevel = fix.edit.newLevel ?? 0;
      const text = fix.edit.text ?? "";
      if (level < 1 || newLevel < 1 || text === "") {
        r.regressionGate = "blocked";
        r.gateReason = "Incomplete retag parameters.";
        return r;
      }
      const blockRe = new RegExp(`<h${level}\\b[^>]*>[\\s\\S]*?</h${level}>`, "gi");
      const blocks = html.match(blockRe) ?? [];
      const matching = blocks.filter((b) => stripTagsLocal(b) === text);
      if (matching.length === 0) {
        r.regressionGate = "idempotent";
        r.gateReason = `No H${level} with that exact text found — already retagged or the text changed.`;
        return r;
      }
      if (matching.length > 1) {
        r.regressionGate = "blocked";
        r.gateReason = `${matching.length} H${level} headings share that text — the target is ambiguous, so an automatic retag is unsafe. Retag it manually.`;
        r.occurrences = matching.length;
        return r;
      }
      const before = matching[0];
      const after = before.replace(new RegExp(`^<h${level}\\b`, "i"), `<h${newLevel}`).replace(new RegExp(`</h${level}>$`, "i"), `</h${newLevel}>`);
      r.before = before;
      r.after = after;
      r.occurrences = 1;
      r.regressionGate = "pass";
      r.gateReason = "Exactly one matching heading; only its open/close tag level changes (class and text preserved).";
      return r;
    }

    case "set-attribute":
    case "inject-jsonld-field":
      r.regressionGate = "manual";
      r.needsValue = true;
      r.gateReason = "This edit is mechanical but needs a value (alt text / date / image URL) that must be supplied before it can be previewed or applied.";
      return r;

    case "infra":
      r.regressionGate = "manual";
      r.gateReason = `This fix lives in ${fix.edit.where ?? "infrastructure"} (not the page HTML) and cannot be previewed as a markup diff.`;
      return r;

    case "manual":
    default:
      r.regressionGate = "manual";
      r.gateReason = "No mechanical edit to preview — this issue needs a content/structure decision.";
      return r;
  }
}
