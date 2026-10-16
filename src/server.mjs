// src/server.mjs — HTTP API + 静态资源
//
// 契约（冻结）：
//   GET    /api/stats          -> 指标快照
//   POST   /api/kv             -> { key, value, ttlMs? } 或 application/octet-stream（?key=）
//   GET    /api/kv/:key        -> 原值（application/octet-stream）
//   DELETE /api/kv/:key
//   GET    /api/keys?limit=&cursor=
//   POST   /api/bench          -> { mb?, codec? }
//   POST   /api/flush
// 所有响应都带 Cache-Control: no-store；错误一律 JSON。

import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CompressedStore, DEFAULT_MAX_BYTES, DEFAULT_MIN_COMPRESS_BYTES } from "./store.mjs";
import { DEFAULT_CODEC, DEFAULT_LEVEL, codecInfo } from "./codec.mjs";
import { makeCorpus, runBench, MB } from "./bench.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = path.resolve(here, "..", "web");
export const VERSION = "0.1.0";
export const DEFAULT_PORT = 5398;
const MAX_BODY_BYTES = 256 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8"
};

function baseHeaders(extra) {
  return Object.assign({ "Cache-Control": "no-store" }, extra || {});
}

function sendJson(res, status, body, extraHeaders) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, baseHeaders(Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length
  }, extraHeaders || {})));
  res.end(payload);
}

function sendError(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  sendJson(res, status, body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        const err = new Error("请求体超过上限 " + limit + " 字节");
        err.status = 413;
        err.code = "PAYLOAD_TOO_LARGE";
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req, MAX_BODY_BYTES);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    const err = new Error("请求体不是合法 JSON");
    err.status = 400;
    err.code = "BAD_JSON";
    throw err;
  }
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(WEB_DIR, rel);
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + path.sep)) {
    sendError(res, 403, "FORBIDDEN", "路径越界");
    return;
  }
  try {
    const data = await readFile(target);
    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, baseHeaders({ "Content-Type": type, "Content-Length": data.length }));
    res.end(data);
  } catch {
    sendError(res, 404, "NOT_FOUND", "静态资源不存在：" + rel);
  }
}

function clampMb(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(n)));
}

export function createServer(options = {}) {
  const store = new CompressedStore({
    maxBytes: options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes,
    minCompressBytes: options.minCompressBytes === undefined ? DEFAULT_MIN_COMPRESS_BYTES : options.minCompressBytes,
    codec: options.codec || DEFAULT_CODEC,
    level: options.level === undefined ? DEFAULT_LEVEL : options.level,
    defaultTtlMs: options.defaultTtlMs || 0,
    allowOversize: options.allowOversize === true
  });

  const benchMbDefault = options.benchMb === undefined ? 8 : options.benchMb;

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://" + (req.headers.host || "127.0.0.1"));
    } catch {
      sendError(res, 400, "BAD_URL", "无法解析的请求 URL");
      return;
    }
    const pathname = url.pathname;
    const segments = pathname.split("/").filter((s) => s.length > 0);
    const method = req.method || "GET";

    try {
      if (segments[0] === "api") {
        await handleApi(req, res, { method, segments, url, store, benchMbDefault });
        return;
      }
      if (method !== "GET" && method !== "HEAD") {
        sendError(res, 405, "METHOD_NOT_ALLOWED", "静态资源只支持 GET：" + pathname);
        return;
      }
      await serveStatic(res, pathname);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const code = err && err.code ? err.code : "INTERNAL";
      sendError(res, status, code, err && err.message ? err.message : String(err));
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      sendError(res, 500, "INTERNAL", err && err.message ? err.message : String(err));
    });
  });

  return { server, store, webDir: WEB_DIR };
}

async function handleApi(req, res, ctx) {
  const { method, segments, url, store, benchMbDefault } = ctx;
  const resource = segments[1] || "";

  if (resource === "stats" && segments.length === 2) {
    if (method !== "GET") return sendError(res, 405, "METHOD_NOT_ALLOWED", "GET /api/stats");
    return sendJson(res, 200, store.stats());
  }

  if (resource === "info" && segments.length === 2) {
    if (method !== "GET") return sendError(res, 405, "METHOD_NOT_ALLOWED", "GET /api/info");
    return sendJson(res, 200, {
      name: "memzip",
      version: VERSION,
      node: process.version,
      zstd: codecInfo().some((c) => c.name === "zstd" && c.available),
      codecs: codecInfo(),
      store: store.config(),
      endpoints: [
        "GET /api/stats",
        "POST /api/kv",
        "GET /api/kv/:key",
        "DELETE /api/kv/:key",
        "GET /api/keys",
        "POST /api/bench",
        "POST /api/flush",
        "GET /api/info"
      ]
    });
  }

  if (resource === "flush" && segments.length === 2) {
    if (method !== "POST") return sendError(res, 405, "METHOD_NOT_ALLOWED", "POST /api/flush");
    await readBody(req, 1024 * 1024).catch(() => Buffer.alloc(0));
    const flushed = store.clear();
    return sendJson(res, 200, { ok: true, flushed });
  }

  if (resource === "keys" && segments.length === 2) {
    if (method !== "GET") return sendError(res, 405, "METHOD_NOT_ALLOWED", "GET /api/keys");
    const limit = Number(url.searchParams.get("limit") || 100);
    const cursor = url.searchParams.get("cursor") || undefined;
    const page = store.list({ limit, cursor });
    return sendJson(res, 200, page);
  }

  if (resource === "kv") {
    if (segments.length === 2) {
      if (method === "POST") return handlePut(req, res, store);
      if (method === "GET" || method === "DELETE") {
        return sendError(res, 400, "MISSING_KEY", method + " /api/kv/:key 需要 key");
      }
      return sendError(res, 405, "METHOD_NOT_ALLOWED", "POST /api/kv");
    }
    const key = decodeURIComponent(segments.slice(2).join("/"));
    if (method === "GET") return handleGet(res, store, key);
    if (method === "DELETE") {
      const existed = store.delete(key);
      if (!existed) return sendError(res, 404, "NOT_FOUND", "key 不存在：" + key, { key });
      return sendJson(res, 200, { deleted: true, key });
    }
    return sendError(res, 405, "METHOD_NOT_ALLOWED", "GET/DELETE /api/kv/:key");
  }

  if (resource === "bench") {
    if (method !== "POST") return sendError(res, 405, "METHOD_NOT_ALLOWED", "POST /api/bench");
    const body = await readJsonBody(req);
    const mb = clampMb(body.mb, benchMbDefault, 256);
    const bytes = Math.round(mb * MB);
    const corpus = makeCorpus(bytes);
    const result = runBench(corpus, { codec: body.codec });
    return sendJson(res, 200, {
      mb,
      source: "synthetic",
      inputBytes: result.inputBytes,
      lossless: result.lossless,
      results: result.results,
      bestRatio: result.bestRatio,
      current: { codec: store.codec, level: store.level }
    });
  }

  return sendError(res, 404, "NOT_FOUND", "未知 API：" + segments.join("/"));
}

async function handlePut(req, res, store) {
  const contentType = String(req.headers["content-type"] || "");
  const url = new URL(req.url, "http://" + (req.headers.host || "127.0.0.1"));
  const isBinary = contentType.indexOf("application/octet-stream") === 0 || contentType.indexOf("text/plain") === 0;

  if (isBinary) {
    const rawKey = url.searchParams.get("key") || req.headers["x-memzip-key"];
    if (!rawKey) {
      return sendError(res, 400, "MISSING_KEY", "二进制写入需要在 URL 上传 ?key=<key> 或带 X-Memzip-Key 头");
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    const ttlMs = Number(url.searchParams.get("ttlMs") || 0);
    const info = setOrThrow(res, store, String(rawKey), body, ttlMs);
    if (!info) return undefined;
    return sendJson(res, 200, info);
  }

  const body = await readJsonBody(req);
  if (typeof body.key !== "string" || body.key.length === 0) {
    return sendError(res, 400, "MISSING_KEY", "请求体需要非空字符串 key");
  }
  if (!Object.prototype.hasOwnProperty.call(body, "value")) {
    return sendError(res, 400, "MISSING_VALUE", "请求体需要 value 字段");
  }
  let value = body.value;
  if (body.encoding === "base64") {
    if (typeof value !== "string") {
      return sendError(res, 400, "BAD_VALUE", "encoding=base64 时 value 必须是 base64 字符串");
    }
    value = Buffer.from(value, "base64");
  }
  const ttlMs = body.ttlMs === undefined ? 0 : Number(body.ttlMs) || 0;
  const info = setOrThrow(res, store, body.key, value, ttlMs);
  if (!info) return undefined;
  return sendJson(res, 200, info);
}

/** 把 store 抛出的领域错误翻译成 HTTP 状态码；返回 undefined 表示已经把错误发出去了。 */
function setOrThrow(res, store, key, value, ttlMs) {
  try {
    return store.set(key, value, { ttlMs });
  } catch (err) {
    if (err && err.code === "VALUE_TOO_LARGE") {
      sendError(res, 413, "PAYLOAD_TOO_LARGE", err.message);
      return null;
    }
    if (err && err.code === "KEY_TOO_LONG") {
      sendError(res, 400, "KEY_TOO_LONG", err.message);
      return null;
    }
    throw err;
  }
}

function handleGet(res, store, key) {
  const hit = store.fetch(key);
  if (!hit) return sendError(res, 404, "NOT_FOUND", "key 不存在或已过期：" + key, { key });
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": hit.buffer.length,
    "X-Memzip-Key": encodeURIComponent(key),
    "X-Memzip-Value-Type": hit.meta.type,
    "X-Memzip-Logical-Bytes": String(hit.meta.logicalBytes),
    "X-Memzip-Physical-Bytes": String(hit.meta.physicalBytes),
    "X-Memzip-Ratio": String(hit.meta.ratio),
    "X-Memzip-Stored": String(hit.meta.stored),
    "X-Memzip-Codec": String(hit.meta.codec || "raw"),
    "X-Memzip-Sha256": hit.meta.sha256,
    "X-Memzip-Decompress-Ms": String(hit.meta.ms)
  };
  res.writeHead(200, baseHeaders(headers));
  res.end(hit.buffer);
}

export function startServer(options = {}) {
  const created = createServer(options);
  const port = options.port === undefined ? DEFAULT_PORT : options.port;
  const host = options.host || "127.0.0.1";
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err && err.code === "EADDRINUSE") {
        const e = new Error("端口 " + port + " 已被占用；换一个 --port 或先停掉旧进程");
        e.code = "EADDRINUSE";
        reject(e);
        return;
      }
      reject(err);
    };
    created.server.once("error", onError);
    created.server.listen(port, host, () => {
      created.server.removeListener("error", onError);
      const addr = created.server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server: created.server,
        store: created.store,
        port: actualPort,
        host,
        url: "http://" + host + ":" + actualPort,
        webDir: created.webDir,
        close: () => new Promise((done) => created.server.close(() => done()))
      });
    });
  });
}
