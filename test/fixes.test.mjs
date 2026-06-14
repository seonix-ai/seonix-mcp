// Unit tests for the safe-fix advisor (propose + static preview gate).
import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePage } from "../dist/audit.js";
import { proposeFixes, previewFix } from "../dist/fixes.js";

const HOST = "https://example.com";
const page = (html, url = HOST + "/") => parsePage(html, url, { statusCode: 200, finalUrl: url });
const issue = (code, evidence = {}, url = HOST + "/") => ({ code, severity: "warning", url, message: "", evidence });
const byCode = (props, code) => props.find((p) => p.code === code);

// ---------------------------------------------------------------------------
// proposeFixes — families & classification
// ---------------------------------------------------------------------------

test("missing_viewport → deterministic meta-inject, invisible", () => {
  const [p] = proposeFixes([issue("missing_viewport")], page(`<head></head>`));
  assert.equal(p.family, "meta-inject");
  assert.equal(p.visibility, "invisible");
  assert.equal(p.edit.type, "insert-head");
  assert.match(p.edit.snippet, /name="viewport"/);
});

test("missing_og_tags → og snippet derived from the page's own title/description/url", () => {
  const html = `<head><title>My Page Title</title><meta name="description" content="A clear description of the page."></head>`;
  const [p] = proposeFixes([issue("missing_og_tags")], page(html));
  assert.equal(p.family, "meta-inject");
  assert.match(p.edit.snippet, /og:title" content="My Page Title"/);
  assert.match(p.edit.snippet, /og:description" content="A clear description of the page."/);
  assert.match(p.edit.snippet, /twitter:card/);
});

test("ssl_mixed_content → content-replace http→https from evidence", () => {
  const ev = { examples: ["http://example.com/a.jpg", "http://cdn.example.com/b.js"] };
  const [p] = proposeFixes([issue("ssl_mixed_content", ev)], page(`<p>x</p>`));
  assert.equal(p.edit.type, "replace-strings");
  assert.equal(p.edit.replacements.length, 2);
  assert.equal(p.edit.replacements[0].after, "https://example.com/a.jpg");
});

test("title_html_entities → decode-title, invisible", () => {
  const [p] = proposeFixes([issue("title_html_entities", { title: "Foo &amp; Bar" })], page(`<title>Foo &amp;amp; Bar</title>`));
  assert.equal(p.edit.type, "decode-title");
  assert.equal(p.visibility, "invisible");
});

test("heading_emoji → strip-heading-emoji, marked visible", () => {
  const [p] = proposeFixes([issue("heading_emoji", { leading_emoji: "📦", heading_level: 2, heading_text: "📦 Lieferung" })], page(`<h2>📦 Lieferung</h2>`));
  assert.equal(p.edit.type, "strip-heading-emoji");
  assert.equal(p.edit.emoji, "📦");
  assert.equal(p.visibility, "visible");
});

test("broken_heading_hierarchy → retag-heading derived from outline", () => {
  const ev = {
    expected_level: 3,
    actual_level: 4,
    after_heading: "Our Services",
    heading_outline: [
      { level: 1, text: "Home" },
      { level: 2, text: "Our Services" },
      { level: 4, text: "Web Design" },
    ],
  };
  const [p] = proposeFixes([issue("broken_heading_hierarchy", ev)], page(`<h1>Home</h1><h2>Our Services</h2><h4>Web Design</h4>`));
  assert.equal(p.edit.type, "retag-heading");
  assert.equal(p.edit.level, 4);
  assert.equal(p.edit.newLevel, 3);
  assert.equal(p.edit.text, "Web Design");
  assert.equal(p.visibility, "invisible");
});

test("images_missing_alt and dates → needs-value", () => {
  const a = byCode(proposeFixes([issue("images_missing_alt", { images_without_alt: 2, examples: [{ src: HOST + "/x.jpg", outer_html: '<img src="/x.jpg">' }] })], page(`<p>x</p>`)), "images_missing_alt");
  assert.equal(a.family, "needs-value");
  const d = byCode(proposeFixes([issue("aeo_jsonld_dates_missing")], page(`<p>x</p>`)), "aeo_jsonld_dates_missing");
  assert.equal(d.family, "needs-value");
});

test("robots / sitemap / speed → infra; thin-content → manual", () => {
  assert.equal(byCode(proposeFixes([issue("aeo_robots_blocks_ai_bot")], null), "aeo_robots_blocks_ai_bot").family, "infra");
  assert.equal(byCode(proposeFixes([issue("sitemap_unreachable")], null), "sitemap_unreachable").family, "infra");
  assert.equal(byCode(proposeFixes([issue("speed_render_blocking")], null), "speed_render_blocking").family, "infra");
  assert.equal(byCode(proposeFixes([issue("low_word_count", { word_count: 12 })], page(`<p>x</p>`)), "low_word_count").family, "manual");
});

// ---------------------------------------------------------------------------
// previewFix — static regression gate
// ---------------------------------------------------------------------------

test("insert-head: pass when absent, idempotent when present", () => {
  const [p] = proposeFixes([issue("missing_viewport")], page(`<head></head>`));
  assert.equal(previewFix(p, `<html><head></head><body></body></html>`).regressionGate, "pass");
  assert.equal(previewFix(p, `<html><head><meta name="viewport" content="x"></head></html>`).regressionGate, "idempotent");
});

test("replace-strings: pass applies, idempotent when none present", () => {
  const [p] = proposeFixes([issue("ssl_mixed_content", { examples: ["http://example.com/a.jpg"] })], page(`<p>x</p>`));
  const ok = previewFix(p, `<img src="http://example.com/a.jpg">`);
  assert.equal(ok.regressionGate, "pass");
  assert.equal(ok.occurrences, 1);
  assert.equal(previewFix(p, `<img src="https://example.com/a.jpg">`).regressionGate, "idempotent");
});

test("decode-title: pass on entities, idempotent on clean", () => {
  const [p] = proposeFixes([issue("title_html_entities", { title: "Foo &amp; Bar" })], page(`<title>Foo &amp;amp; Bar</title>`));
  const ok = previewFix(p, `<title>Foo &amp;amp; Bar</title>`);
  assert.equal(ok.regressionGate, "pass");
  assert.equal(ok.after, "Foo &amp; Bar");
  assert.equal(previewFix(p, `<title>Foo &amp; Bar</title>`).regressionGate, "idempotent");
});

test("strip-heading-emoji: pass when present, idempotent when gone", () => {
  const [p] = proposeFixes([issue("heading_emoji", { leading_emoji: "📦" })], page(`<h2>📦 Lieferung</h2>`));
  assert.equal(previewFix(p, `<h2>📦 Lieferung</h2>`).regressionGate, "pass");
  assert.equal(previewFix(p, `<h2>Lieferung</h2>`).regressionGate, "idempotent");
});

test("retag-heading: pass on unique match, BLOCKED on ambiguous, idempotent on none", () => {
  const ev = {
    expected_level: 3, actual_level: 4, after_heading: "Services",
    heading_outline: [{ level: 2, text: "Services" }, { level: 4, text: "Web Design" }],
  };
  const [p] = proposeFixes([issue("broken_heading_hierarchy", ev)], page(`<h2>Services</h2><h4>Web Design</h4>`));
  // unique → pass, only the tag changes
  const ok = previewFix(p, `<h2>Services</h2><h4 class="x">Web Design</h4>`);
  assert.equal(ok.regressionGate, "pass");
  assert.match(ok.after, /^<h3\b/);
  assert.match(ok.after, /class="x"/); // class preserved
  // two H4s with the same text → ambiguous → blocked (the key safety property)
  const blocked = previewFix(p, `<h4>Web Design</h4><h4>Web Design</h4>`);
  assert.equal(blocked.regressionGate, "blocked");
  assert.equal(blocked.occurrences, 2);
  // no matching H4 → idempotent
  assert.equal(previewFix(p, `<h3>Web Design</h3>`).regressionGate, "idempotent");
});

test("needs-value and infra previews return a manual gate", () => {
  const nv = byCode(proposeFixes([issue("images_missing_alt", { examples: [{ outer_html: "<img>" }] })], page(`<p>x</p>`)), "images_missing_alt");
  const nvRes = previewFix(nv, `<img>`);
  assert.equal(nvRes.regressionGate, "manual");
  assert.equal(nvRes.needsValue, true);
  const inf = byCode(proposeFixes([issue("sitemap_unreachable")], null), "sitemap_unreachable");
  assert.equal(previewFix(inf, ``).regressionGate, "manual");
});
