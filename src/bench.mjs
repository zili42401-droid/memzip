// src/bench.mjs — 基准测试 + 语料生成 + 控制台表格
//
// CLI 的 bench/demo 与 HTTP 的 POST /api/bench 共用这里的实现，保证两边数字同源。
// 语料默认用确定性 PRNG 合成（形状模仿 Agent 会话 JSONL 日志），也可以用 --file 换成真实文件。
// 单位约定：MB = 1,000,000 字节（十进制），全文统一。

import { readFile } from "node:fs/promises";
import zlib from "node:zlib";
import { getCodec, codecNames, resolveLevel } from "./codec.mjs";
import { mbPerSec, round } from "./metrics.mjs";

export const MB = 1e6;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "会话", "压缩", "内存", "缓存", "命中", "淘汰", "阈值", "编解码", "吞吐", "延迟",
  "工具", "调用", "参数", "结果", "错误", "重试", "权限", "沙箱", "工作区", "路径",
  "token", "session", "memory", "cache", "compress", "zstd", "buffer", "stream",
  "agent", "plugin", "harness", "profile", "config", "route", "server", "client",
  "读取文件", "写入文件", "执行命令", "检索记忆", "生成计划", "验收标准", "回归测试",
  "the quick brown fox", "no external dependency", "zero install", "in-memory index"
];

const TOOLS = [
  "read", "write", "edit", "grep", "glob", "pwsh", "web_search", "web_fetch",
  "subagent", "todo_write", "send_message", "skill", "task_board_run"
];

const ROLES = ["system", "user", "assistant", "tool"];

const PATHS = [
  "projects/memzip/src/store.mjs",
  "projects/memzip/src/codec.mjs",
  "projects/memzip/web/app.js",
  "projects/memzip/test/smoke.mjs",
  "C:/Users/demo/Documents/deepseek-harness/default-workspace/memory/MEMORY.md",
  "C:/Users/demo/AppData/Local/Programs/DeepSeek Harness/resources/app.asar"
];

function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

function textOf(rnd, minWords, maxWords) {
  const n = minWords + Math.floor(rnd() * (maxWords - minWords + 1));
  const parts = [];
  for (let i = 0; i < n; i += 1) parts.push(pick(rnd, WORDS));
  return parts.join(" ");
}

/** 合成 targetBytes 字节的类 JSONL 语料（确定性：同一个 seed 出同一份数据）。 */
export function makeCorpus(targetBytes, seed = 0x5eed1234) {
  const rnd = mulberry32(seed);
  const lines = [];
  let size = 0;
  let i = 0;
  while (size < targetBytes) {
    i += 1;
    const role = pick(rnd, ROLES);
    const record = {
      t: "2026-10-16T" + String(10 + (i % 12)).padStart(2, "0") + ":" + String(i % 60).padStart(2, "0") + ":07.123Z",
      session: "session-" + (100000 + (i % 977)).toString(16) + "-4f00-a43a",
      seq: i,
      role,
      text: textOf(rnd, 12, 48),
    };
    if (role === "tool") {
      record.tool = pick(rnd, TOOLS);
      record.args = { path: pick(rnd, PATHS), limit: 2000, offset: 1 };
      record.ms = 5 + Math.floor(rnd() * 400);
      record.ok = rnd() > 0.08;
    } else {
      record.tokens = { in: 120 + Math.floor(rnd() * 900), out: 40 + Math.floor(rnd() * 600) };
    }
    const line = JSON.stringify(record) + "\n";
    lines.push(line);
    size += Buffer.byteLength(line, "utf8");
  }
  return Buffer.from(lines.join(""), "utf8");
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function isZstdFramed(buf) {
  return buf.length > 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
}

/**
 * 多帧 zstd 解码。DSH 的会话日志是"一个 flush 一帧"的拼接文件，Node 的
 * zstdDecompressSync 与 createZstdDecompress 都只吐第一帧（实测 5055 帧的文件只解出 245 字节），
 * 所以要按魔数切帧后逐帧解压。魔数也可能出现在帧内部，因此切片失败时向后合并再试。
 */
export function decodeZstdFrames(buf) {
  const offsets = [];
  let idx = buf.indexOf(ZSTD_MAGIC, 0);
  while (idx >= 0) {
    offsets.push(idx);
    idx = buf.indexOf(ZSTD_MAGIC, idx + 4);
  }
  if (offsets.length === 0) throw new Error("不是 zstd 数据：找不到帧魔数");
  const parts = [];
  let i = 0;
  while (i < offsets.length) {
    let j = i + 1;
    for (;;) {
      const end = j < offsets.length ? offsets[j] : buf.length;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[i], end)));
        break;
      } catch (err) {
        if (j < offsets.length) {
          j += 1;
          continue;
        }
        throw new Error("第 " + (i + 1) + " 个 zstd 帧解压失败：" + err.message);
      }
    }
    i = j;
  }
  return Buffer.concat(parts);
}

/** 读语料文件；若是多帧 zstd（.zstd）自动解出原始 JSONL 文本。 */
export async function loadCorpusFile(file) {
  const buf = await readFile(file);
  if (isZstdFramed(buf)) return decodeZstdFrames(buf);
  return buf;
}

/** 默认对比矩阵：与 README 的实测基准表一一对应。 */
export function defaultMatrix(options = {}) {
  const wanted = [
    ["zstd", 1],
    ["zstd", 3],
    ["zstd", 9],
    ["zstd", 19],
    ["gzip", 1],
    ["gzip", 6],
    ["gzip", 9],
    ["brotli", 3],
    ["brotli", 6],
    ["deflate", 6],
  ];
  const only = options.codec ? String(options.codec) : null;
  const out = [];
  for (const [name, level] of wanted) {
    if (only && name !== only) continue;
    if (!codecNames().includes(name)) continue;
    let codec;
    try {
      codec = getCodec(name);
    } catch {
      continue;
    }
    out.push({ codec: name, level: resolveLevel(name, level), label: codec.name + " L" + level });
  }
  if (out.length === 0) {
    throw new Error("没有可用的编解码参与 bench" + (only ? "（--codec " + only + "）" : ""));
  }
  return out;
}

/** 在给定语料上跑一遍所有编解码，每项都做解压校验（lossless）。 */
export function runBench(buffer, options = {}) {
  const matrix = options.matrix || defaultMatrix(options);
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const bytes = source.length;
  const results = [];
  for (const item of matrix) {
    const impl = getCodec(item.codec);
    const level = resolveLevel(item.codec, item.level);
    const t0 = process.hrtime.bigint();
    const compressed = impl.compress(source, level);
    const t1 = process.hrtime.bigint();
    const decompressed = impl.decompress(compressed);
    const t2 = process.hrtime.bigint();
    const compressMs = Number(t1 - t0) / 1e6;
    const decompressMs = Number(t2 - t1) / 1e6;
    results.push({
      codec: item.codec,
      level,
      label: impl.name + " L" + level,
      inputBytes: bytes,
      compressedBytes: compressed.length,
      ratio: round(bytes / compressed.length, 3),
      compressMs: round(compressMs, 2),
      compressMBps: round(mbPerSec(bytes, compressMs), 1),
      decompressMs: round(decompressMs, 2),
      decompressMBps: round(mbPerSec(bytes, decompressMs), 1),
      lossless: Buffer.compare(decompressed, source) === 0,
    });
  }
  results.sort((a, b) => b.ratio - a.ratio);
  const best = results.reduce((acc, row) => (row.ratio > acc.ratio ? row : acc), results[0]);
  const fastest = results
    .filter((row) => row.codec === "zstd" || row.codec === "gzip" || row.codec === "brotli")
    .reduce((acc, row) => (row.compressMBps > acc.compressMBps ? row : acc), results[0]);
  return {
    inputBytes: bytes,
    inputMB: round(bytes / MB, 3),
    codecs: results.map((row) => row.codec + "-" + row.level),
    lossless: results.every((row) => row.lossless),
    results,
    bestRatio: best.label,
    fastestLabel: fastest.label,
  };
}

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return round(n / 1024, 1) + " KB";
  if (n < 1024 * 1024 * 1024) return round(n / (1024 * 1024), 2) + " MB";
  return round(n / (1024 * 1024 * 1024), 2) + " GB";
}

export function formatMB(bytes) {
  return round(bytes / MB, 3);
}

/** 终端表格对齐：CJK 全角字符算 2 个显示宽度。 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    width += cp > 0x2e80 && cp < 0xfe00 ? 2 : 1;
  }
  return width;
}

export function padCell(text, width) {
  const s = String(text);
  const diff = width - displayWidth(s);
  return diff > 0 ? s + " ".repeat(diff) : s;
}

export function renderTable(headers, rows) {
  const widths = headers.map((h) => displayWidth(h));
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], displayWidth(cell));
    });
  }
  const line = (cells) => "| " + cells.map((cell, i) => padCell(cell, widths[i])).join(" | ") + " |";
  const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  const out = [line(headers), sep];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

/** 与 README 基准表同格式的控制台表格。 */
export function formatBenchTable(result) {
  const headers = ["编解码", "压缩后", "压缩比", "压缩 ms", "压缩 MB/s", "解压 ms", "解压 MB/s"];
  const rows = result.results.map((row) => [
    row.label,
    round(row.compressedBytes / MB, 2) + " MB",
    row.ratio.toFixed(2) + "x",
    String(row.compressMs),
    String(row.compressMBps),
    String(row.decompressMs),
    String(row.decompressMBps),
  ]);
  const head =
    "语料 " +
    result.inputMB +
    " MB（" +
    result.inputBytes +
    " 字节），无损校验：" +
    (result.lossless ? "全部通过" : "存在失败项！");
  return head + "\n" + renderTable(headers, rows);
}
