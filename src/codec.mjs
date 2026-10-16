// src/codec.mjs — 编解码注册表
//
// 设计要点
// 1. 注册表化：内置 zstd / gzip / brotli / deflate，外部可以用 registerCodec() 追加自定义实现。
// 2. 可用性探测：zstd 需要 Node >= 22.15（zlib.zstdCompressSync）。探测失败时该条目被标记为
//    unavailable，而不是静默换成别的算法 —— 用不了的编解码必须能被 info / bench 看见。
// 3. 等级有两套：合法区间 minLevel..maxLevel，以及"有实测基准的推荐等级" levels（bench 用后者）。

import zlib from "node:zlib";

export const DEFAULT_CODEC = "zstd";
export const DEFAULT_LEVEL = 3;

const hasZstd =
  typeof zlib.zstdCompressSync === "function" && typeof zlib.zstdDecompressSync === "function";

export const zstdAvailable = hasZstd;

const registry = new Map();

function normalizeLevel(level, fallback) {
  const n = Number(level);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function define(spec) {
  const codec = {
    name: String(spec.name),
    label: spec.label || spec.name,
    available: spec.available !== false,
    levels: Array.isArray(spec.levels) ? spec.levels.slice() : [],
    minLevel: normalizeLevel(spec.minLevel, 0),
    maxLevel: normalizeLevel(spec.maxLevel, 9),
    defaultLevel: normalizeLevel(spec.defaultLevel, 6),
    note: spec.note || "",
    compress: spec.compress,
    decompress: spec.decompress,
  };
  registry.set(codec.name, codec);
  return codec;
}

define({
  name: "zstd",
  label: "zstd",
  available: hasZstd,
  levels: [1, 3, 9, 19],
  minLevel: 1,
  maxLevel: 22,
  defaultLevel: 3,
  note: hasZstd
    ? "Node 原生 zstd；L3 是甜点（约 6x / 400+ MB/s），L19 只适合离线归档"
    : "本机 Node 未提供 zlib.zstdCompressSync（需要 Node >= 22.15）",
  compress(buffer, level) {
    return zlib.zstdCompressSync(buffer, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
    });
  },
  decompress(buffer) {
    return zlib.zstdDecompressSync(buffer);
  },
});

define({
  name: "gzip",
  label: "gzip",
  available: true,
  levels: [1, 6, 9],
  minLevel: 1,
  maxLevel: 9,
  defaultLevel: 6,
  note: "兼容性最好但压缩比最低，gzip 头部还有固定开销",
  compress(buffer, level) {
    return zlib.gzipSync(buffer, { level });
  },
  decompress(buffer) {
    return zlib.gunzipSync(buffer);
  },
});

define({
  name: "brotli",
  label: "brotli",
  available: true,
  levels: [3, 6, 11],
  minLevel: 0,
  maxLevel: 11,
  defaultLevel: 6,
  note: "高压缩比，解码比编码便宜；L11 很慢",
  compress(buffer, level) {
    return zlib.brotliCompressSync(buffer, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level },
    });
  },
  decompress(buffer) {
    return zlib.brotliDecompressSync(buffer);
  },
});

define({
  name: "deflate",
  label: "deflate",
  available: true,
  levels: [1, 6, 9],
  minLevel: 1,
  maxLevel: 9,
  defaultLevel: 6,
  note: "裸 zlib 流，无头部校验；体积与 gzip 相近",
  compress(buffer, level) {
    return zlib.deflateSync(buffer, { level });
  },
  decompress(buffer) {
    return zlib.inflateSync(buffer);
  },
});

/** 注册（或覆盖）一个自定义编解码。compress/decompress 都必须返回 Buffer。 */
export function registerCodec(spec) {
  if (!spec || typeof spec.name !== "string" || spec.name.length === 0) {
    throw new TypeError("registerCodec 需要 name");
  }
  if (typeof spec.compress !== "function" || typeof spec.decompress !== "function") {
    throw new TypeError("registerCodec 需要 compress(buffer, level) 与 decompress(buffer) 函数");
  }
  return define(spec);
}

export function hasCodec(name) {
  return registry.has(String(name));
}

export function listCodecs() {
  return [...registry.values()];
}

export function codecNames() {
  return [...registry.keys()];
}

export function getCodec(name) {
  const key = String(name);
  const codec = registry.get(key);
  if (!codec) {
    throw new Error("未知编解码 " + key + "（可用：" + codecNames().join(" / ") + "）");
  }
  if (!codec.available) {
    throw new Error("编解码 " + key + " 在本机不可用：" + (codec.note || "原因未知"));
  }
  return codec;
}

/** 把等级夹到该编解码的合法区间，非法输入回落到 defaultLevel。 */
export function resolveLevel(name, level) {
  const codec = getCodec(name);
  const raw = normalizeLevel(level, NaN);
  if (!Number.isFinite(raw)) return codec.defaultLevel;
  if (raw < codec.minLevel) return codec.minLevel;
  if (raw > codec.maxLevel) return codec.maxLevel;
  return raw;
}

/** 供 info / API 用的可序列化描述（不含函数）。 */
export function codecInfo() {
  return listCodecs().map((codec) => ({
    name: codec.name,
    label: codec.label,
    available: codec.available,
    levels: codec.levels,
    minLevel: codec.minLevel,
    maxLevel: codec.maxLevel,
    defaultLevel: codec.defaultLevel,
    note: codec.note,
  }));
}

/** 一次性压缩：返回 { codec, level, buffer }。 */
export function compressWith(name, level, buffer) {
  const codec = getCodec(name);
  const lv = resolveLevel(name, level);
  return { codec: codec.name, level: lv, buffer: codec.compress(buffer, lv) };
}

/** 一次性解压。 */
export function decompressWith(name, buffer) {
  return getCodec(name).decompress(buffer);
}
