/* A local stand-in for Cloudflare Workers' static-asset serving.
 *
 * WHY THIS EXISTS: `npm run build:static` exiting 0 does not prove the game
 * runs from out/. A static export can compile cleanly and still 404 a chunk or
 * lose an asset path, and the only way to find that out is to serve the export
 * the way the real host will and drive the game in it.
 *
 * "The way the real host will" is the point — a generic `http-server` is a
 * DIFFERENT host and would not catch a path that only Cloudflare rewrites.
 * This server implements the routing Workers documents for a Worker that has
 * an `assets` block and NO `main` script (see wrangler.jsonc), so what it
 * serves is what Cloudflare serves:
 *
 *   - html_handling: "auto-trailing-slash" — /foo.html redirects to /foo,
 *     /foo/index.html redirects to /foo/, and bare paths resolve to either.
 *   - not_found_handling: "404-page" — an unmatched path is answered with the
 *     nearest 404.html walking up the tree, at status 404.
 *   - _headers is PARSED, not served; its rules are applied on top of the
 *     defaults, and the file itself 404s like any other non-asset.
 *   - default headers on an asset: Cache-Control: public, max-age=0,
 *     must-revalidate, plus ETag and Content-Type.
 *
 * Docs: /workers/static-assets/routing/static-site-generation/,
 * /workers/static-assets/headers/, /workers/static-assets/binding/.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".hdr": "image/vnd.radiance",
  ".ktx2": "image/ktx2",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/* ---- _headers ----------------------------------------------------------
   Rule blocks: a line starting with "/" (or an absolute URL) opens a block,
   the indented "Name: value" lines under it are its headers. "*" is a splat
   and matches greedily across "/". A request inherits EVERY matching rule. */
function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      cur = { pattern: line.trim(), set: [], unset: [] };
      rules.push(cur);
    } else if (cur) {
      const t = line.trim();
      if (t.startsWith("! ")) cur.unset.push(t.slice(2).trim().toLowerCase());
      else {
        const i = t.indexOf(":");
        if (i > 0) cur.set.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
      }
    }
  }
  return rules;
}

function matchPattern(pattern, pathname) {
  // absolute-URL rules match on the path portion only for our purposes
  let p = pattern;
  if (/^https?:\/\//.test(p)) p = new URL(p).pathname;
  const rx = new RegExp(
    "^" +
      p
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[\\s\\S]*") +
      "$"
  );
  return rx.test(pathname);
}

function applyHeaders(rules, pathname, headers) {
  for (const r of rules) {
    if (!matchPattern(r.pattern, pathname)) continue;
    for (const [k, v] of r.set) {
      const key = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase());
      // "If a header is applied twice in the _headers file, the values are
      // joined with a comma separator" — but a rule overrides a DEFAULT.
      if (key && !headers.__fromFile?.has(k.toLowerCase())) delete headers[key];
      const existing = headers[k];
      headers[k] = existing ? `${existing}, ${v}` : v;
      (headers.__fromFile ||= new Set()).add(k.toLowerCase());
    }
    for (const k of r.unset) {
      const key = Object.keys(headers).find((h) => h.toLowerCase() === k);
      if (key) delete headers[key];
    }
  }
  delete headers.__fromFile;
  return headers;
}

/** Resolve a request path to { kind: "asset"|"redirect"|"notfound", ... }
 *  exactly as Workers' auto-trailing-slash html_handling does. */
export function resolveAsset(root, pathname) {
  const RESERVED = new Set(["/_headers", "/_redirects", "/.assetsignore"]);
  if (RESERVED.has(pathname)) return { kind: "notfound" };

  const abs = (p) => path.join(root, decodeURIComponent(p));

  // 1. exact file hit (non-HTML assets land here)
  if (pathname !== "/" && !pathname.endsWith("/") && isFile(abs(pathname))) {
    if (pathname.endsWith(".html")) {
      // /foo.html -> /foo ; /foo/index.html -> /foo/
      const to = pathname.endsWith("/index.html")
        ? pathname.slice(0, -"index.html".length)
        : pathname.slice(0, -".html".length);
      return { kind: "redirect", to, status: 307 };
    }
    return { kind: "asset", file: abs(pathname) };
  }

  // 2. directory index
  if (pathname.endsWith("/")) {
    const idx = abs(pathname + "index.html");
    if (isFile(idx)) return { kind: "asset", file: idx };
    const asFile = abs(pathname.slice(0, -1) + ".html");
    if (isFile(asFile)) return { kind: "redirect", to: pathname.slice(0, -1), status: 307 };
    return { kind: "notfound" };
  }

  // 3. bare path -> foo.html, else foo/index.html with a trailing slash
  if (isFile(abs(pathname + ".html"))) return { kind: "asset", file: abs(pathname + ".html") };
  if (isFile(abs(pathname + "/index.html")))
    return { kind: "redirect", to: pathname + "/", status: 307 };

  return { kind: "notfound" };
}

/** The nearest 404.html walking up from the request path (not_found_handling
 *  = "404-page"). Returns null when there is none anywhere. */
function nearest404(root, pathname) {
  let dir = pathname.endsWith("/") ? pathname : path.posix.dirname(pathname);
  for (;;) {
    const c = path.join(root, dir, "404.html");
    if (isFile(c)) return c;
    if (dir === "/" || dir === "." || dir === "") return null;
    dir = path.posix.dirname(dir);
  }
}

/**
 * Start the emulator.
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
export function serveExport(root, { port = 0 } = {}) {
  const headerRules = isFile(path.join(root, "_headers"))
    ? parseHeaders(readFileSync(path.join(root, "_headers"), "utf8"))
    : [];

  const send = (res, status, file, pathname) => {
    const body = readFileSync(file);
    const headers = {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": String(body.length),
      /* Workers' default for a static asset. Anything stronger has to come
         from a _headers rule, which is the thing under test. */
      "Cache-Control": "public, max-age=0, must-revalidate",
      ETag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
    };
    res.writeHead(status, applyHeaders(headerRules, pathname, headers));
    res.end(body);
  };

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const r = resolveAsset(root, pathname);
    if (r.kind === "asset") return send(res, 200, r.file, pathname);
    if (r.kind === "redirect") {
      res.writeHead(r.status, { Location: r.to });
      return res.end();
    }
    const page = nearest404(root, pathname);
    if (page) return send(res, 404, page, pathname);
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      resolve({
        port: p,
        url: `http://localhost:${p}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Read the parsed _headers rules — used by the header assertions. */
export function headerRulesOf(root) {
  return isFile(path.join(root, "_headers"))
    ? parseHeaders(readFileSync(path.join(root, "_headers"), "utf8"))
    : [];
}

export { applyHeaders, matchPattern };
