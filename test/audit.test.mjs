// Unit tests for the audit checks. Pure Node (node:test) — no extra deps.
// Run: npm test  (builds first, then `node --test test/`).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePage,
  countVisibleWords,
  extractHtmlLang,
  extractLinks,
  normalizeUrlKey,
  checkTitleHtmlEntities,
  checkTitleLowercase,
  checkLowWordCount,
  checkNoInternalLinks,
  checkNoindex,
  checkLargePage,
  checkSoft404,
  checkAeoSocialMeta,
  checkAeoStructuredData,
  checkDuplicates,
  checkBoilerplateHeadings,
  checkPaginationNoindexRecommendation,
  checkBrokenInternalLinks,
  checkOrphanedPages,
  checkCrawlDepth,
  checkRedirects,
  parseSitemapXml,
  robotsAllows,
  extractRobotsSitemaps,
  looksLikeXml,
  isPaginationArchiveURL,
} from "../dist/audit.js";

const HOST = "https://example.com";
function mkPage(html, url = HOST + "/", opts = {}) {
  return parsePage(html, url, { statusCode: opts.statusCode ?? 200, finalUrl: opts.finalUrl ?? url, xRobotsTag: opts.xRobotsTag ?? "" });
}
const codes = (issues) => issues.map((i) => i.code);
const has = (issues, code) => issues.some((i) => i.code === code);

// ---------------------------------------------------------------------------
// parsePage — content / links / language
// ---------------------------------------------------------------------------

test("countVisibleWords ignores script/style and counts letter words", () => {
  const html = `<html><body><p>Hello brave new world</p><script>var x = 1; alert("spam spam spam");</script><style>.a{color:red}</style> 123 — •</body></html>`;
  assert.equal(countVisibleWords(html), 4); // "123", "—", "•" are not letter-words
});

test("extractHtmlLang normalizes to ISO 639-1 prefix", () => {
  assert.equal(extractHtmlLang(`<html lang="de-DE">`), "de");
  assert.equal(extractHtmlLang(`<html lang="EN">`), "en");
  assert.equal(extractHtmlLang(`<html>`), "");
});

test("extractLinks splits internal vs external by host and de-dups", () => {
  const html = `<a href="/a">a</a><a href="/a#x">a again</a><a href="https://other.com/x">ext</a><a href="mailto:x@y.z">mail</a><a href="#top">anchor</a>`;
  const { internalUrls, externalCount } = extractLinks(html, HOST + "/");
  assert.equal(internalUrls.length, 1); // /a and /a#x collapse to one
  assert.equal(internalUrls[0], normalizeUrlKey(HOST + "/a"));
  assert.equal(externalCount, 1);
});

// ---------------------------------------------------------------------------
// Title quality
// ---------------------------------------------------------------------------

test("title_html_entities flags double-encoded but not correctly-encoded titles", () => {
  assert.ok(has(checkTitleHtmlEntities(mkPage(`<title>Foo &amp;amp; Bar</title>`)), "title_html_entities"));
  assert.equal(checkTitleHtmlEntities(mkPage(`<title>Foo &amp; Bar</title>`)).length, 0);
  assert.equal(checkTitleHtmlEntities(mkPage(`<title>AT&T &amp; Sons</title>`)).length, 0);
});

test("title_lowercase: flags en/de/ru lowercase start, respects brands & languages", () => {
  assert.ok(has(checkTitleLowercase(mkPage(`<html lang="en"><title>hello there friends</title>`)), "title_lowercase"));
  assert.equal(checkTitleLowercase(mkPage(`<html lang="en"><title>iPhone tips and tricks</title>`)).length, 0); // brand
  assert.equal(checkTitleLowercase(mkPage(`<html lang="fr"><title>bonjour le monde</title>`)).length, 0); // lang not enforced
  assert.equal(checkTitleLowercase(mkPage(`<html lang="en"><title>5 ways to save money</title>`)).length, 0); // starts with digit
  assert.equal(checkTitleLowercase(mkPage(`<html lang="en"><title>Hello there</title>`)).length, 0); // already capital
});

// ---------------------------------------------------------------------------
// Content / indexability
// ---------------------------------------------------------------------------

test("low_word_count fires under 300 words", () => {
  assert.ok(has(checkLowWordCount(mkPage(`<p>only a few words here</p>`)), "low_word_count"));
  const long = "<p>" + "word ".repeat(400) + "</p>";
  assert.equal(checkLowWordCount(mkPage(long)).length, 0);
});

test("no_internal_links fires when there are none", () => {
  assert.ok(has(checkNoInternalLinks(mkPage(`<a href="https://other.com">ext</a>`)), "no_internal_links"));
  assert.equal(checkNoInternalLinks(mkPage(`<a href="/about">about</a>`)).length, 0);
});

test("noindex_detected reads meta robots and X-Robots-Tag", () => {
  assert.ok(has(checkNoindex(mkPage(`<meta name="robots" content="noindex,follow">`)), "noindex_detected"));
  assert.ok(has(checkNoindex(mkPage(`<p>x</p>`, HOST + "/", { xRobotsTag: "noindex" })), "noindex_detected"));
  assert.equal(checkNoindex(mkPage(`<meta name="robots" content="index,follow">`)).length, 0);
});

test("large_page fires over 3MB of HTML", () => {
  const big = "<html><body>" + "x".repeat(3 * 1024 * 1024 + 10) + "</body></html>";
  assert.ok(has(checkLargePage(mkPage(big)), "large_page"));
  assert.equal(checkLargePage(mkPage(`<p>small</p>`)).length, 0);
});

test("soft_404 needs an error-like title AND a thin body on a 200", () => {
  assert.ok(has(checkSoft404(mkPage(`<title>404 Page Not Found</title><p>oops</p>`)), "soft_404"));
  assert.equal(checkSoft404(mkPage(`<title>404 Not Found</title><p>` + "word ".repeat(150) + `</p>`)).length, 0); // enough words
  assert.equal(checkSoft404(mkPage(`<title>Our Products</title><p>x</p>`)).length, 0); // no indicator
});

// ---------------------------------------------------------------------------
// AEO — social meta
// ---------------------------------------------------------------------------

test("aeo_og_incomplete fires when 2+ core tags missing, tolerates one", () => {
  const onlyTitle = `<meta property="og:title" content="X">`;
  assert.ok(has(checkAeoSocialMeta(mkPage(onlyTitle)), "aeo_og_incomplete"));
  const allButImage = `<meta property="og:title" content="X"><meta property="og:description" content="Y"><meta property="og:url" content="${HOST}/"><meta name="twitter:card" content="summary">`;
  assert.equal(checkAeoSocialMeta(mkPage(allButImage)).length, 0); // only og:image missing → tolerated
});

// ---------------------------------------------------------------------------
// AEO — JSON-LD structured data
// ---------------------------------------------------------------------------

function ld(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
}

test("Yoast-style @id author reference is NOT flagged as author_not_person", () => {
  const graph = ld({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Article", "headline": "Post", "datePublished": "2024-01-01", "author": { "name": "Jane", "@id": HOST + "/#/schema/person/abc" } },
      { "@type": "Person", "@id": HOST + "/#/schema/person/abc", "name": "Jane", "url": HOST + "/author/jane" },
    ],
  });
  const issues = checkAeoStructuredData(mkPage(graph));
  assert.equal(has(issues, "aeo_jsonld_author_not_person"), false);
  assert.equal(has(issues, "aeo_jsonld_dates_missing"), false);
});

test("Organization author IS flagged; missing datePublished IS flagged", () => {
  const html = ld({ "@type": "Article", "headline": "X", "author": { "@type": "Organization", "name": "Acme" } });
  const issues = checkAeoStructuredData(mkPage(html));
  assert.ok(has(issues, "aeo_jsonld_author_not_person"));
  assert.ok(has(issues, "aeo_jsonld_dates_missing"));
});

test("duplicate vs conflicting type", () => {
  const dup = ld([{ "@type": "Article", "headline": "Same" }, { "@type": "Article", "headline": "Same" }]);
  assert.ok(has(checkAeoStructuredData(mkPage(dup)), "aeo_jsonld_duplicate_type"));
  const conflict = ld([{ "@type": "Article", "headline": "A" }, { "@type": "Article", "headline": "B" }]);
  assert.ok(has(checkAeoStructuredData(mkPage(conflict)), "aeo_jsonld_conflicting_data"));
});

test("type_not_recognized flags typos but not real types", () => {
  assert.ok(has(checkAeoStructuredData(mkPage(ld({ "@type": "Artical", "headline": "x", "datePublished": "2024-01-01" }))), "aeo_jsonld_type_not_recognized"));
  assert.equal(has(checkAeoStructuredData(mkPage(ld({ "@type": "ImageObject", "name": "x" }))), "aeo_jsonld_type_not_recognized"), false);
});

test("person_incomplete flags name-only Person", () => {
  assert.ok(has(checkAeoStructuredData(mkPage(ld({ "@type": "Person", "name": "Jane" }))), "aeo_jsonld_person_incomplete"));
  assert.equal(has(checkAeoStructuredData(mkPage(ld({ "@type": "Person", "name": "Jane", "url": HOST + "/jane" }))), "aeo_jsonld_person_incomplete"), false);
});

test("faq_without_content fires when questions are not visible headings", () => {
  const faq = ld({ "@type": "FAQPage", "mainEntity": [{ "@type": "Question", "name": "What is X?" }, { "@type": "Question", "name": "How does Y work?" }] });
  assert.ok(has(checkAeoStructuredData(mkPage(faq)), "aeo_jsonld_faq_without_content"));
  const faqVisible = `<h3>What is X?</h3><h3>How does Y work?</h3>` + faq;
  assert.equal(has(checkAeoStructuredData(mkPage(faqVisible)), "aeo_jsonld_faq_without_content"), false);
});

// ---------------------------------------------------------------------------
// Cross-page
// ---------------------------------------------------------------------------

test("duplicate_title / duplicate_meta_desc group across pages, skip pagination", () => {
  const t = `<title>Same Title Here</title><meta name="description" content="same description text repeated across pages here">`;
  const pages = [mkPage(t, HOST + "/a"), mkPage(t, HOST + "/b"), mkPage(t, HOST + "/blog/page/2/")];
  const issues = checkDuplicates(pages);
  assert.equal(issues.filter((i) => i.code === "duplicate_title").length, 2); // /a, /b only
  assert.equal(issues.filter((i) => i.code === "duplicate_meta_desc").length, 2);
});

test("trailing_slash_duplicate when both forms are 200", () => {
  const pages = [mkPage(`<p>x</p>`, HOST + "/a"), mkPage(`<p>x</p>`, HOST + "/a/")];
  assert.ok(has(checkDuplicates(pages), "trailing_slash_duplicate"));
});

test("boilerplate_heading_repeated needs 10+ pages and strictly >50%", () => {
  const withH = `<h1>Unique</h1><h2>Contact Us</h2>`;
  const without = `<h1>Unique</h1><h2>Other</h2>`;
  // 10 pages, heading on 6 (>50%) → fire
  const pages6 = [];
  for (let i = 0; i < 6; i++) pages6.push(mkPage(withH, `${HOST}/p${i}`));
  for (let i = 6; i < 10; i++) pages6.push(mkPage(without, `${HOST}/p${i}`));
  assert.ok(has(checkBoilerplateHeadings(pages6), "boilerplate_heading_repeated"));
  // exactly 5/10 (==50%) → no fire
  const pages5 = [];
  for (let i = 0; i < 5; i++) pages5.push(mkPage(withH, `${HOST}/q${i}`));
  for (let i = 5; i < 10; i++) pages5.push(mkPage(without, `${HOST}/q${i}`));
  assert.equal(has(checkBoilerplateHeadings(pages5), "boilerplate_heading_repeated"), false);
});

test("pagination_noindex_recommended fires for indexable paginated archives", () => {
  const pages = [mkPage(`<p>x</p>`, HOST + "/blog/page/2/"), mkPage(`<p>x</p>`, HOST + "/blog/page/3/")];
  assert.ok(has(checkPaginationNoindexRecommendation(pages), "pagination_noindex_recommended"));
  const noindexed = [mkPage(`<meta name="robots" content="noindex">`, HOST + "/blog/page/2/")];
  assert.equal(has(checkPaginationNoindexRecommendation(noindexed), "pagination_noindex_recommended"), false);
});

// ---------------------------------------------------------------------------
// Crawl graph
// ---------------------------------------------------------------------------

test("broken_internal_link finds links to crawled 4xx pages", () => {
  const a = mkPage(`<a href="/gone">dead</a><a href="/ok">ok</a>`, HOST + "/");
  const gone = mkPage(``, HOST + "/gone", { statusCode: 404 });
  const ok = mkPage(`<p>fine</p>`, HOST + "/ok");
  const issues = checkBrokenInternalLinks([a, gone, ok]);
  assert.equal(issues.filter((i) => i.code === "broken_internal_link").length, 1);
  assert.equal(issues[0].evidence.status_code, 404);
});

test("orphaned_page excludes root and linked pages", () => {
  const home = mkPage(`<a href="/linked">go</a>`, HOST + "/");
  const linked = mkPage(`<p>x</p>`, HOST + "/linked");
  const orphan = mkPage(`<p>x</p>`, HOST + "/orphan");
  const issues = checkOrphanedPages([home, linked, orphan]);
  assert.deepEqual(issues.map((i) => i.url), [HOST + "/orphan"]);
});

test("deep_crawl_depth flags pages >4 clicks from home", () => {
  // chain: / -> /1 -> /2 -> /3 -> /4 -> /5 (depth 5)
  const pages = [];
  for (let i = 0; i <= 5; i++) {
    const url = i === 0 ? HOST + "/" : `${HOST}/${i}`;
    const next = `${HOST}/${i + 1}`;
    pages.push(mkPage(`<a href="${next}">next</a>`, url));
  }
  const issues = checkCrawlDepth(pages, HOST + "/");
  assert.ok(has(issues, "deep_crawl_depth"));
  assert.ok(issues.some((i) => i.evidence.depth === 5));
});

test("checkRedirects: broken / loop / too-many", () => {
  const broken = mkPage(``, HOST + "/a", { statusCode: 404 });
  broken.redirectChain = [{ url: HOST + "/a", statusCode: 301 }];
  assert.ok(has(checkRedirects(broken), "broken_redirect"));

  const many = mkPage(`<p>x</p>`, HOST + "/z");
  many.redirectChain = [
    { url: HOST + "/a", statusCode: 301 },
    { url: HOST + "/b", statusCode: 301 },
    { url: HOST + "/c", statusCode: 301 },
  ];
  assert.ok(has(checkRedirects(many), "too_many_redirects"));

  const loop = mkPage(`<p>x</p>`, HOST + "/l");
  loop.redirectChain = [{ url: HOST + "/a", statusCode: 301 }, { url: HOST + "/a", statusCode: 301 }];
  assert.ok(has(checkRedirects(loop), "redirect_loop"));
});

// ---------------------------------------------------------------------------
// Sitemap / robots helpers
// ---------------------------------------------------------------------------

test("parseSitemapXml classifies urlset / index and counts lastmod", () => {
  const urlset = `<urlset><url><loc>${HOST}/a</loc><lastmod>2024-01-01</lastmod></url><url><loc>${HOST}/b</loc></url></urlset>`;
  const p = parseSitemapXml(urlset);
  assert.equal(p.kind, "urlset");
  assert.equal(p.urlCount, 2);
  assert.equal(p.lastmodCount, 1);
  const idx = `<sitemapindex><sitemap><loc>${HOST}/sm1.xml</loc></sitemap></sitemapindex>`;
  const pi = parseSitemapXml(idx);
  assert.equal(pi.kind, "index");
  assert.deepEqual(pi.childLocs, [HOST + "/sm1.xml"]);
});

test("robotsAllows longest-match: Disallow root, Allow re-opens subpath", () => {
  const body = "User-agent: *\nDisallow: /\nAllow: /public/";
  assert.equal(robotsAllows(body, "Googlebot", "/"), false);
  assert.equal(robotsAllows(body, "Googlebot", "/public/page"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow:", "Googlebot", "/"), true); // empty disallow = allow all
});

test("extractRobotsSitemaps + looksLikeXml + isPaginationArchiveURL", () => {
  assert.deepEqual(extractRobotsSitemaps("Sitemap: https://x.com/s.xml\nDisallow: /"), ["https://x.com/s.xml"]);
  assert.equal(looksLikeXml("﻿  <?xml version='1.0'?>"), true);
  assert.equal(looksLikeXml("<!doctype html>"), true);
  assert.equal(looksLikeXml("not xml"), false);
  assert.equal(isPaginationArchiveURL(HOST + "/blog/page/2/"), true);
  assert.equal(isPaginationArchiveURL(HOST + "/about"), false);
});
