import { createReadStream, promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultRoot = path.resolve(process.env.BEK_WEB_ROOT ?? "/app/dist");
const defaultPort = Number(process.env.BEK_WEB_PORT ?? 5173);
const defaultHost = process.env.BEK_WEB_HOST ?? "0.0.0.0";
const defaultApiUrl = "http://localhost:4317";

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
]);

export function resolveRuntimeApiUrl(env = process.env) {
  const value =
    firstNonEmpty(
      env.BEK_WEB_API_URL,
      env.VITE_BEK_API_URL,
      env.BEK_PUBLIC_URL,
    ) ?? defaultApiUrl;
  return normalizeApiUrl(value) ?? defaultApiUrl;
}

export function buildRuntimeConfigScript(env = process.env) {
  return `window.__BEK_CONFIG__ = ${JSON.stringify({
    apiUrl: resolveRuntimeApiUrl(env),
  })};\n`;
}

export function createBekStaticServer({
  root = defaultRoot,
  env = process.env,
} = {}) {
  const resolvedRoot = path.resolve(root);
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }

    const url = new URL(
      request.url ?? "/",
      "http://" + (request.headers.host ?? "localhost"),
    );
    if (url.pathname === "/bek-config.js") {
      serveRuntimeConfig(request, response, env);
      return;
    }

    const filePath = await resolveFile(resolvedRoot, url.pathname);
    if (!filePath) {
      response.writeHead(404);
      response.end();
      return;
    }

    try {
      await fs.access(filePath);
      response.writeHead(200, headersFor(filePath));
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim());
}

function normalizeApiUrl(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "/") {
    return "/";
  }
  return trimmed.replace(/\/+$/, "");
}

function serveRuntimeConfig(request, response, env) {
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(buildRuntimeConfigScript(env));
}

function headersFor(filePath) {
  const headers = {
    "content-type":
      mimeTypes.get(path.extname(filePath)) ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  };
  if (filePath.includes(path.sep + "assets" + path.sep)) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else {
    headers["cache-control"] = "no-cache";
  }
  if (path.basename(filePath) === "bek-config.js") {
    headers["cache-control"] = "no-store";
  }
  return headers;
}

function safePath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const resolved = path.resolve(root, "." + decoded);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

async function resolveFile(root, urlPath) {
  const candidate = safePath(root, urlPath);
  if (!candidate) {
    return null;
  }

  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) {
      return path.join(candidate, "index.html");
    }
    if (stat.isFile()) {
      return candidate;
    }
  } catch {
    // Fall through to SPA fallback.
  }

  return path.join(root, "index.html");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  createBekStaticServer().listen(defaultPort, defaultHost, () => {
    console.log(
      "Bek web listening on http://" + defaultHost + ":" + defaultPort,
    );
  });
}
