/**
 * wordpress-fixers.ts — ARCHIVED, NOT WIRED INTO THE SERVER.
 *
 * This module is kept "for the record". It holds the WordPress write/content
 * tools that the seonix-seo-mcp server used to expose before it was reshaped
 * into a platform-agnostic, read-only auditor:
 *
 *   wp_list_content, wp_get_content, wp_update_content, wp_set_media_alt,
 *   wp_set_post_author, wp_set_yoast_meta, wp_set_yoast_title_template
 *
 * The server itself (`src/index.ts`) NO LONGER imports anything from here and
 * advertises none of these tools — auditing now reports problems and how-it-
 * should-be recommendations for ANY site and never modifies a live site.
 * Whether and how to fix is the user's job.
 *
 * The code below is preserved verbatim (the WPClient write methods, the
 * WP-CLI-over-SSH helpers, the tool definitions and the dispatch handlers) so
 * the WordPress remediation capability can be revived in a separate tool/
 * package later. It is self-contained: it does NOT import from `index.ts`, and
 * declares its own minimal MCP `Tool`/`CallToolResult`-shaped types so it
 * `tsc`-compiles on its own (it is intentionally tree-shaken out of the built
 * server because nothing references it).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PKG_VERSION = "2.0.0";
const USER_AGENT = `seonix-seo-mcp/${PKG_VERSION} (+https://github.com/Effect-Agency/seonix-seo-mcp)`;

// ---------------------------------------------------------------------------
// Minimal local types (this file is standalone — it does not depend on the MCP
// SDK types nor on index.ts). Shapes mirror @modelcontextprotocol/sdk closely
// enough that the handlers below could be re-wired with a thin adapter.
// ---------------------------------------------------------------------------

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface CallToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A user-actionable error whose message is safe to surface to the agent. */
class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Small shared helpers (duplicated here so the module stands alone)
// ---------------------------------------------------------------------------

/** Strip all HTML tags from a fragment and collapse whitespace. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// WPClient — typed thin wrapper over the WordPress REST API
// ---------------------------------------------------------------------------

interface WPConfig {
  url: string; // origin, no trailing slash
  user: string;
  appPassword: string;
}

interface SSHConfig {
  host: string;
  port: string;
  user: string;
  key: string;
  path: string; // remote WordPress install path
}

type ContentType = "post" | "page";

interface WPListItem {
  id: number;
  link: string;
  title: string;
  status: string;
  seo_title_length: number;
  seo_description_length: number;
}

class WPClient {
  constructor(private readonly cfg: WPConfig) {}

  private authHeader(): string {
    // Application Passwords use HTTP Basic auth. The password may contain the
    // spaces WordPress shows (e.g. "abcd efgh ijkl"); WP accepts them with or
    // without spaces — we send as configured.
    const token = Buffer.from(`${this.cfg.user}:${this.cfg.appPassword}`).toString("base64");
    return `Basic ${token}`;
  }

  private restBase(): string {
    return `${this.cfg.url}/wp-json/wp/v2`;
  }

  /** Perform an authenticated REST request and parse the JSON response. */
  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const url = new URL(`${this.restBase()}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        signal: controller.signal,
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new ToolError(`Could not reach WordPress at ${this.cfg.url} (${String(e)}). Check WP_URL and network access.`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new ToolError(
        `WordPress rejected the credentials (HTTP ${res.status}). Verify WP_USER and WP_APP_PASSWORD (an Application Password, not the login password), and that the user can edit the requested content.`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j.message) detail = j.message;
      } catch {
        /* keep raw */
      }
      throw new ToolError(`WordPress REST error (HTTP ${res.status}): ${detail}`);
    }

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new ToolError(`WordPress returned a non-JSON response from ${path}. Is this a WordPress site with the REST API enabled?`);
    }
    return { data, headers: res.headers };
  }

  /** List posts or pages (id, link, title, computed SEO lengths). */
  async listContent(type: ContentType, search?: string): Promise<WPListItem[]> {
    const endpoint = type === "page" ? "/pages" : "/posts";
    const { data } = await this.request<WpRestPost[]>("GET", endpoint, {
      query: { per_page: 50, search, _fields: "id,link,title,status,excerpt,yoast_head_json", status: "publish,draft,pending,private,future" },
    });
    return data.map((p) => {
      const title = stripTags(p.title?.rendered ?? "");
      const yoast = p.yoast_head_json;
      const seoTitle = yoast?.title ?? title;
      const seoDesc = yoast?.description ?? stripTags(p.excerpt?.rendered ?? "");
      return {
        id: p.id,
        link: p.link,
        title,
        status: p.status,
        seo_title_length: [...seoTitle].length,
        seo_description_length: [...seoDesc].length,
      };
    });
  }

  /** Get one item with raw block content + meta (context=edit). */
  async getContent(id: number, type: ContentType): Promise<WpRestPost> {
    const endpoint = type === "page" ? "/pages" : "/posts";
    const { data } = await this.request<WpRestPost>("GET", `${endpoint}/${id}`, { query: { context: "edit" } });
    return data;
  }

  /** Update post_content (block content). */
  async updateContent(id: number, type: ContentType, content: string): Promise<{ id: number; link: string }> {
    const endpoint = type === "page" ? "/pages" : "/posts";
    const { data } = await this.request<WpRestPost>("POST", `${endpoint}/${id}`, { body: { content } });
    return { id: data.id, link: data.link };
  }

  /** Reassign the author of a post/page (fixes empty JSON-LD author). */
  async setAuthor(id: number, type: ContentType, authorId: number): Promise<{ id: number; author: number }> {
    const endpoint = type === "page" ? "/pages" : "/posts";
    const { data } = await this.request<WpRestPost>("POST", `${endpoint}/${id}`, { body: { author: authorId } });
    return { id: data.id, author: data.author };
  }

  /** Set the alt text of a media item. */
  async setMediaAlt(mediaId: number, alt: string): Promise<{ id: number; alt_text: string }> {
    const { data } = await this.request<{ id: number; alt_text: string }>("POST", `/media/${mediaId}`, { body: { alt_text: alt } });
    return { id: data.id, alt_text: data.alt_text };
  }
}

// Minimal shapes of the WP REST objects we touch.
interface WpRestPost {
  id: number;
  link: string;
  status: string;
  author: number;
  title?: { rendered?: string; raw?: string };
  content?: { rendered?: string; raw?: string };
  excerpt?: { rendered?: string };
  meta?: Record<string, unknown>;
  yoast_head_json?: { title?: string; description?: string };
}

// ---------------------------------------------------------------------------
// WP-CLI over SSH (for Yoast meta, which is NOT writable via standard REST)
// ---------------------------------------------------------------------------

/** Run a `wp …` command on the remote host over SSH, inside WP_PATH. */
async function wpCliOverSSH(ssh: SSHConfig, wpArgs: string[]): Promise<string> {
  // Build the remote command. We pass each wp arg as a separately single-quoted
  // shell token so values with spaces survive the remote shell intact.
  const remote = `cd ${shellQuote(ssh.path)} && wp ${wpArgs.map(shellQuote).join(" ")}`;
  const args = [
    "-p",
    ssh.port,
    "-i",
    ssh.key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    `${ssh.user}@${ssh.host}`,
    remote,
  ];
  try {
    const { stdout } = await execFileAsync("ssh", args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    throw new ToolError(`WP-CLI over SSH failed: ${err.stderr?.trim() || err.message || String(e)}`);
  }
}

/** POSIX single-quote a string for safe interpolation into a remote shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadWPConfig(): WPConfig {
  const url = (process.env.WP_URL || "").trim().replace(/\/+$/, "");
  const user = (process.env.WP_USER || "").trim();
  const appPassword = (process.env.WP_APP_PASSWORD || "").trim();
  if (!url || !user || !appPassword) {
    throw new ToolError(
      "WordPress is not configured. Set WP_URL, WP_USER and WP_APP_PASSWORD (a WordPress Application Password) in the MCP server env. This tool needs them to talk to the WordPress REST API.",
    );
  }
  return { url, user, appPassword };
}

function loadSSHConfig(): SSHConfig | null {
  const host = (process.env.WP_SSH_HOST || "").trim();
  const user = (process.env.WP_SSH_USER || "").trim();
  const key = (process.env.WP_SSH_KEY || "").trim();
  const path = (process.env.WP_PATH || "").trim();
  if (!host || !user || !key || !path) return null;
  return { host, user, key, path, port: (process.env.WP_SSH_PORT || "22").trim() };
}

// ---------------------------------------------------------------------------
// Tool definitions (the seven WordPress write/content tools)
// ---------------------------------------------------------------------------

export const WORDPRESS_FIXER_TOOLS: Tool[] = [
  {
    name: "wp_list_content",
    description:
      "List WordPress posts or pages (id, link, title, status, and computed SEO title/description lengths). Requires WP auth. Use this to find the id of the content you want to inspect or fix.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["post", "page"], description: "Content type to list." },
        search: { type: "string", description: "Optional search term to filter by title/content." },
      },
      required: ["type"],
    },
  },
  {
    name: "wp_get_content",
    description:
      "Get one WordPress post or page with its RAW block content and meta (context=edit). Use this to read the exact markup before editing it (e.g. to fix image alt attributes, emoji headings, or http:// resources in blocks).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The post/page id." },
        type: { type: "string", enum: ["post", "page"], description: "Content type." },
      },
      required: ["id", "type"],
    },
  },
  {
    name: "wp_update_content",
    description:
      "Update a WordPress post/page's content (post_content / block markup). Use to fix alt attributes inside blocks, remove emoji from headings, or rewrite http:// resource URLs to https://. Pass the FULL new content; partial updates replace the whole body.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The post/page id." },
        type: { type: "string", enum: ["post", "page"], description: "Content type." },
        content: { type: "string", description: "The full new block content / HTML for the post body." },
      },
      required: ["id", "type", "content"],
    },
  },
  {
    name: "wp_set_media_alt",
    description:
      "Set the alt text on a WordPress media (attachment) item. This fixes 'image missing alt' for images served from the media library. IMPORTANT: decorative images must get a short HONEST non-empty alt (e.g. 'Decorative divider') — scanners count alt=\"\" as missing and ignore role=presentation/aria-hidden.",
    inputSchema: {
      type: "object",
      properties: {
        media_id: { type: "number", description: "The attachment (media) id." },
        alt: { type: "string", description: "The alt text to set (non-empty)." },
      },
      required: ["media_id", "alt"],
    },
  },
  {
    name: "wp_set_post_author",
    description:
      "Reassign the author of a post/page to a real WordPress user. Fixes JSON-LD Article author that renders as an empty Person ({name:'',@id:''}) — that is caused by post_author=0. Use wp_list_users-equivalent knowledge or ask the operator for the target author_id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The post/page id." },
        type: { type: "string", enum: ["post", "page"], description: "Content type." },
        author_id: { type: "number", description: "The WordPress user id to set as author." },
      },
      required: ["id", "type", "author_id"],
    },
  },
  {
    name: "wp_set_yoast_meta",
    description:
      "Set the Yoast SEO title and/or meta description for a specific post/page (_yoast_wpseo_title / _yoast_wpseo_metadesc). CONSTRAINT: Yoast meta is NOT writable via the standard WP REST API, so this tool uses WP-CLI over SSH. It requires WP_SSH_HOST/WP_SSH_USER/WP_SSH_KEY/WP_PATH (and optional WP_SSH_PORT). If SSH is not configured, it returns a clear error with your options.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The post/page id." },
        title: { type: "string", description: "Optional Yoast SEO title to set." },
        metadesc: { type: "string", description: "Optional Yoast meta description to set." },
      },
      required: ["id"],
    },
  },
  {
    name: "wp_set_yoast_title_template",
    description:
      "Set the Yoast SEO title TEMPLATE for a post type site-wide (e.g. title-post / title-page in the wpseo_titles option). Changing it to drop '%%sep%% %%sitename%%' instantly fixes 'title too long' across every post that has no custom title — no reindex needed. Uses WP-CLI over SSH (requires WP_SSH_* + WP_PATH). If SSH is not configured, returns a clear error.",
    inputSchema: {
      type: "object",
      properties: {
        title_key: {
          type: "string",
          description: "The wpseo_titles key, e.g. 'title-post', 'title-page', or 'title-tax-category'.",
        },
        template: {
          type: "string",
          description: "The new template, e.g. '%%title%%' (drops the site name & separator).",
        },
      },
      required: ["title_key", "template"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatch (the WordPress write/content handlers)
// ---------------------------------------------------------------------------

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

/** Friendly, actionable message when a Yoast tool is invoked without SSH. */
function yoastNoSshError(): string {
  return [
    "Yoast SEO meta (_yoast_wpseo_title / _yoast_wpseo_metadesc) and the Yoast title templates are NOT writable through the standard WordPress REST API, and on some hosts POST /wp-admin/options.php is blocked (HTTP 503 behind Cloudflare / a WAF).",
    "",
    "To enable this tool you have two options:",
    "  1) Configure SSH + WP-CLI: set WP_SSH_HOST, WP_SSH_PORT (optional, default 22), WP_SSH_USER, WP_SSH_KEY (path to a private key) and WP_PATH (the WordPress install path on the server). This server then runs `wp post meta update …` / `wp option patch update wpseo_titles …` over SSH.",
    "  2) Install a small companion WordPress plugin that exposes these fields via an authenticated REST route (planned for v2 of this server).",
  ].join("\n");
}

/**
 * Dispatch one of the seven WordPress write/content tools. ARCHIVED — not
 * called by the live server. Returns null for an unrecognized name so a caller
 * could chain it after its own dispatch.
 */
export async function dispatchWordpressFixer(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | null> {
  switch (name) {
    case "wp_list_content": {
      const type = asContentType(args.type);
      const search = args.search === undefined ? undefined : String(args.search);
      const wp = new WPClient(loadWPConfig());
      const items = await wp.listContent(type, search);
      return ok({ type, count: items.length, items });
    }

    case "wp_get_content": {
      const type = asContentType(args.type);
      const id = asId(args.id, "id");
      const wp = new WPClient(loadWPConfig());
      const item = await wp.getContent(id, type);
      return ok({
        id: item.id,
        type,
        link: item.link,
        status: item.status,
        author: item.author,
        title: item.title?.raw ?? item.title?.rendered ?? "",
        content: item.content?.raw ?? item.content?.rendered ?? "",
        meta: item.meta ?? {},
      });
    }

    case "wp_update_content": {
      const type = asContentType(args.type);
      const id = asId(args.id, "id");
      const content = String(args.content ?? "");
      if (content === "") return fail("content is required (pass the full new post body).");
      const wp = new WPClient(loadWPConfig());
      const res = await wp.updateContent(id, type, content);
      return ok({ updated: true, ...res });
    }

    case "wp_set_media_alt": {
      const mediaId = asId(args.media_id, "media_id");
      const alt = String(args.alt ?? "").trim();
      if (alt === "") return fail("alt is required and must be non-empty (use a short honest alt even for decorative images).");
      const wp = new WPClient(loadWPConfig());
      const res = await wp.setMediaAlt(mediaId, alt);
      return ok({ updated: true, ...res });
    }

    case "wp_set_post_author": {
      const type = asContentType(args.type);
      const id = asId(args.id, "id");
      const authorId = asId(args.author_id, "author_id");
      const wp = new WPClient(loadWPConfig());
      const res = await wp.setAuthor(id, type, authorId);
      return ok({ updated: true, ...res });
    }

    case "wp_set_yoast_meta": {
      const id = asId(args.id, "id");
      const title = args.title === undefined ? undefined : String(args.title);
      const metadesc = args.metadesc === undefined ? undefined : String(args.metadesc);
      if (title === undefined && metadesc === undefined) {
        return fail("Provide at least one of title or metadesc.");
      }
      const ssh = loadSSHConfig();
      if (!ssh) return fail(yoastNoSshError());
      // Ensure WP creds are at least present for symmetry/clarity (not used by SSH path).
      const applied: Record<string, string> = {};
      if (title !== undefined) {
        await wpCliOverSSH(ssh, ["post", "meta", "update", String(id), "_yoast_wpseo_title", title]);
        applied._yoast_wpseo_title = title;
      }
      if (metadesc !== undefined) {
        await wpCliOverSSH(ssh, ["post", "meta", "update", String(id), "_yoast_wpseo_metadesc", metadesc]);
        applied._yoast_wpseo_metadesc = metadesc;
      }
      return ok({ updated: true, id, applied, via: "wp-cli over ssh" });
    }

    case "wp_set_yoast_title_template": {
      const titleKey = String(args.title_key ?? "").trim();
      const template = String(args.template ?? "");
      if (titleKey === "") return fail("title_key is required, e.g. 'title-post' or 'title-page'.");
      if (template === "") return fail("template is required, e.g. '%%title%%'.");
      const ssh = loadSSHConfig();
      if (!ssh) return fail(yoastNoSshError());
      // `wp option patch update wpseo_titles <key> <value>` updates one key of
      // the serialized wpseo_titles option without rewriting the whole array.
      const out = await wpCliOverSSH(ssh, ["option", "patch", "update", "wpseo_titles", titleKey, template]);
      return ok({ updated: true, option: "wpseo_titles", key: titleKey, template, output: out, via: "wp-cli over ssh" });
    }

    default:
      return null;
  }
}

function asContentType(v: unknown): ContentType {
  const s = String(v ?? "").toLowerCase();
  if (s === "post" || s === "page") return s;
  throw new ToolError("type must be 'post' or 'page'.");
}

function asId(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ToolError(`${field} must be a positive integer.`);
  return n;
}
