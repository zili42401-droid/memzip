#!/usr/bin/env node
// bin/memzip.mjs — memzip 命令行入口
//
// 用法：memzip <serve|bench|demo|put|get|stats|info> [选项]
// put/get/stats 通过 HTTP 与正在运行的 serve 通信（默认 http://127.0.0.1:5398）。

import process from "node:process";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { CompressedStore, DEFAULT_MAX_BYTES, DEFAULT_MIN_COMPRESS_BYTES } from "../src/store.mjs";
import { DEFAULT_PORT, VERSION, startServer } from "../src/server.mjs";
import { formatBenchTable, formatBytes, loadCorpusFile, makeCorpus, renderTable, runBench, MB } from "../src/bench.mjs";
import { round } from "../src/metrics.mjs";
import { DEFAULT_CODEC, DEFAULT_LEVEL, codecInfo, resolveLevel, zstdAvailable } from "../src/codec.mjs";

const DEFAULT_URL = process.env.MEMZIP_URL || "http://127.0.0.1:" + DEFAULT_PORT;

const HELP = [
  "memzip " + VERSION + " — 用户态压缩内存缓存服务",
  "",
  "用法：memzip <命令> [选项]",
  "",
  "命令：",
  "  serve [--port 5398] [--max-mb 512] [--codec zstd] [--level 3] [--min-bytes 256] [--open]",
  "        起 HTTP 服务 + Web 面板",
  "  bench [--file <路径>] [--mb 16] [--codec zstd] [--json]",
  "        在真实文件或合成语料上对比所有编解码，输出压缩比 / 吞吐表",
  "  demo  [--mb 24] [--codec zstd] [--level 3] [--json]",
  "        塞入 N MB 数据，打印逻辑大小 / 物理大小 / 压缩比 / 省下多少 / 耗时",
  "  put <key> <value|@文件> [--ttl <毫秒>] [--url ...]",
  "        写入一条数据（@ 开头表示从文件读取二进制内容）",
  "  get <key> [--out <文件>] [--url ...]",
  "        读取原值（默认写到标准输出）",
  "  stats [--url ...] [--json]",
  "        打印服务端指标",
  "  info  打印本机编解码能力与默认参数（不联服务）",
  "",
  "通用选项：",
  "  --url <地址>   put/get/stats 连接的地址，默认 " + DEFAULT_URL,
  "  --json         以 JSON 输出（便于脚本处理）",
  "  --help         显示本帮助",
  "",
  "单位约定：1 MB = 1,000,000 字节；缓存预算 --max-mb 也是十进制 MB。",
  "默认编解码 zstd L3：实测 5.96x / 420 MB/s，是压缩比与速度的甜点。"
].join("\n");

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const name = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i += 1;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

function mbToBytes(mb, fallbackBytes) {
  const n = Number(mb);
  if (!Number.isFinite(n) || n <= 0) return fallbackBytes;
  return Math.round(n * MB);
}

async function api(url, pathname, options) {
  const target = String(url).replace(/\/+$/, "") + pathname;
  try {
    return await fetch(target, options);
  } catch (err) {
    const code = err && err.cause && err.cause.code ? err.cause.code : err && err.message;
    fail("连不上 " + url + "（" + code + "）。先跑：node bin/memzip.mjs serve");
    return null;
  }
}

function printKv(label, value) {
  process.stdout.write("  " + label.padEnd(12) + value + "\n");
}

async function cmdServe(flags) {
  const port = Number(flags.port || DEFAULT_PORT);
  const maxMb = Number(flags["max-mb"] || 512);
  const codec = flags.codec || DEFAULT_CODEC;
  const level = flags.level === undefined ? DEFAULT_LEVEL : resolveLevel(codec, Number(flags.level));
  const minBytes = Number(flags["min-bytes"] || DEFAULT_MIN_COMPRESS_BYTES);
  const running = await startServer({
    port,
    host: flags.host || "127.0.0.1",
    maxBytes: mbToBytes(maxMb, DEFAULT_MAX_BYTES),
    codec,
    level,
    minCompressBytes: minBytes,
    allowOversize: flags["allow-oversize"] === true
  });
  process.stdout.write("memzip " + VERSION + " 已启动\n");
  printKv("面板", running.url + "/");
  printKv("API", running.url + "/api/stats");
  printKv("物理预算", maxMb + " MB（压缩后字节，" + running.store.maxBytes + " B）");
  printKv("编解码", codec + " L" + level + "（阈值 " + minBytes + " B）");
  printKv("Node", process.version);
  process.stdout.write("按 Ctrl+C 停止\n");
  if (flags.open) {
    execFile("cmd", ["/c", "start", "", running.url + "/"], () => {});
  }
  const shutdown = async () => {
    process.stdout.write("\n正在关闭…\n");
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise(() => {});
}

async function cmdBench(flags) {
  const file = typeof flags.file === "string" ? flags.file : null;
  const mb = Number(flags.mb || 16);
  const corpus = file ? await loadCorpusFile(file) : makeCorpus(Math.round(mb * MB));
  const result = runBench(corpus, { codec: typeof flags.codec === "string" ? flags.codec : undefined });
  if (flags.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write("memzip bench — " + (file ? "真实文件 " + file : "合成语料") + "\n");
  process.stdout.write(formatBenchTable(result) + "\n");
  process.stdout.write("最高压缩比：" + result.bestRatio + "；基准建议默认 zstd L3（甜点）\n");
}

async function cmdDemo(flags) {
  const mb = Number(flags.mb || 24);
  const codec = flags.codec || DEFAULT_CODEC;
  const level = flags.level === undefined ? DEFAULT_LEVEL : Number(flags.level);
  const minBytes = Number(flags["min-bytes"] || DEFAULT_MIN_COMPRESS_BYTES);
  const chunkBytes = Math.max(64 * 1024, Number(flags["chunk-kb"] || 256) * 1024);
  const totalBytes = Math.round(mb * MB);
  const file = typeof flags.file === "string" ? flags.file : null;
  const corpus = file ? await loadCorpusFile(file) : makeCorpus(totalBytes);
  const store = new CompressedStore({
    maxBytes: Math.max(totalBytes * 2, 64 * MB),
    minCompressBytes: minBytes,
    codec,
    level
  });

  // 按换行切成"记录条"，模拟真实的批量写入而不是一整块。
  const records = [];
  let start = 0;
  for (let i = 0; i < corpus.length; i += 1) {
    if (corpus[i] === 10 && i - start >= chunkBytes) {
      records.push(corpus.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < corpus.length) records.push(corpus.subarray(start));

  const t0 = process.hrtime.bigint();
  records.forEach((slice, index) => {
    store.set("corpus-" + String(index).padStart(6, "0"), Buffer.from(slice));
  });
  const t1 = process.hrtime.bigint();

  let okCount = 0;
  for (let i = 0; i < records.length; i += 1) {
    const back = store.get("corpus-" + String(i).padStart(6, "0"));
    if (Buffer.isBuffer(back) && Buffer.compare(back, records[i]) === 0) okCount += 1;
  }
  const t2 = process.hrtime.bigint();

  const stats = store.stats();
  if (flags.json) {
    process.stdout.write(JSON.stringify({ records: records.length, stats, lossless: okCount === records.length }, null, 2) + "\n");
    return;
  }
  const putMs = Number(t1 - t0) / 1e6;
  const getMs = Number(t2 - t1) / 1e6;
  process.stdout.write(
    "memzip demo — " + records.length + " 条记录，每条约 " + Math.round(chunkBytes / 1024) + " KB" + (file ? "（真实语料 " + file + "）" : "（合成语料）") + "\n"
  );
  printKv("逻辑大小", round(stats.logicalBytes / MB, 3) + " MB（" + stats.logicalBytes + " B）");
  printKv("物理大小", round(stats.physicalBytes / MB, 3) + " MB（" + stats.physicalBytes + " B）");
  printKv("压缩比", stats.ratio.toFixed(2) + "x");
  printKv("省下", round(stats.savedBytes / MB, 3) + " MB");
  printKv("编解码", codec + " L" + level + "（阈值 " + minBytes + " B）");
  printKv("写入耗时", round(putMs, 1) + " ms（" + round(stats.logicalBytes / 1e6 / (putMs / 1000), 1) + " MB/s）");
  printKv("解压校验", round(getMs, 1) + " ms（" + okCount + "/" + records.length + " 条逐字节一致）");
  printKv("驱逐", stats.evictions + " 条；淘汰预算 " + formatBytes(store.maxBytes));
  if (stats.ratio < 4) {
    process.stdout.write("警告：压缩比低于 4x，语料可能不可压（例如已压缩过的数据）\n");
  }
}

async function cmdPut(flags, positional) {
  const key = positional[0];
  if (!key) fail("put 需要 <key>；用法：memzip put <key> <value|@文件>");
  const url = flags.url || DEFAULT_URL;
  let response;
  if (typeof flags.file === "string" || (positional[1] && positional[1].startsWith("@"))) {
    const file = typeof flags.file === "string" ? flags.file : positional[1].slice(1);
    const buf = await readFile(file);
    const ttl = flags.ttl ? "&ttlMs=" + encodeURIComponent(flags.ttl) : "";
    response = await api(url, "/api/kv?key=" + encodeURIComponent(key) + ttl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf
    });
  } else {
    if (positional[1] === undefined) fail("put 需要 value（字符串）或用 @文件 指定二进制文件");
    response = await api(url, "/api/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: positional[1], ttlMs: flags.ttl ? Number(flags.ttl) : 0 })
    });
  }
  const body = await response.json();
  if (!response.ok) fail("写入失败：" + response.status + " " + JSON.stringify(body));
  if (flags.json) {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }
  process.stdout.write("已写入 " + body.key + "：" + body.logicalBytes + " B -> " + body.physicalBytes + " B，压缩比 " + body.ratio + "x（stored=" + body.stored + "）\n");
}

async function cmdGet(flags, positional) {
  const key = positional[0];
  if (!key) fail("get 需要 <key>；用法：memzip get <key> [--out 文件]");
  const url = flags.url || DEFAULT_URL;
  const response = await api(url, "/api/kv/" + encodeURIComponent(key));
  if (!response.ok) {
    const body = await response.text();
    fail("读取失败：" + response.status + " " + body.slice(0, 300));
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      key,
      bytes: buf.length,
      type: response.headers.get("x-memzip-value-type"),
      ratio: response.headers.get("x-memzip-ratio"),
      sha256: response.headers.get("x-memzip-sha256"),
      value: buf.toString("utf8")
    }, null, 2) + "\n");
    return;
  }
  if (typeof flags.out === "string") {
    await writeFile(flags.out, buf);
    process.stdout.write("已写入 " + flags.out + "（" + buf.length + " 字节）\n");
    return;
  }
  process.stdout.write(buf);
}

async function cmdStats(flags) {
  const url = flags.url || DEFAULT_URL;
  const response = await api(url, "/api/stats");
  const body = await response.json();
  if (!response.ok) fail("stats 失败：" + response.status + " " + JSON.stringify(body));
  if (flags.json) {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }
  const rows = [
    ["条目数", String(body.entries)],
    ["逻辑字节", formatBytes(body.logicalBytes) + "（" + body.logicalBytes + " B）"],
    ["物理字节", formatBytes(body.physicalBytes) + "（" + body.physicalBytes + " B）"],
    ["压缩比", body.ratio + "x"],
    ["省下", formatBytes(body.savedBytes)],
    ["预算", formatBytes(body.maxBytes)],
    ["命中/未命中", body.hits + " / " + body.misses + "（命中率 " + (body.hitRate * 100).toFixed(1) + "%）"],
    ["驱逐/过期", body.evictions + " / " + body.expired],
    ["get 延迟", "p50 " + body.p50GetMs + " ms，p95 " + body.p95GetMs + " ms"],
    ["吞吐", "压缩 " + body.throughput.compressMBps + " MB/s，解压 " + body.throughput.decompressMBps + " MB/s"],
    ["运行时长", round(body.uptimeMs / 1000, 1) + " s"]
  ];
  process.stdout.write("memzip stats — " + url + "\n" + renderTable(["指标", "值"], rows) + "\n");
}

async function cmdInfo(flags) {
  const info = {
    name: "memzip",
    version: VERSION,
    node: process.version,
    zstdAvailable,
    defaultCodec: DEFAULT_CODEC,
    defaultLevel: DEFAULT_LEVEL,
    defaultMaxMB: 512,
    defaultMinCompressBytes: DEFAULT_MIN_COMPRESS_BYTES,
    codecs: codecInfo()
  };
  if (flags.json) {
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    return;
  }
  process.stdout.write("memzip " + VERSION + " — 本机能力\n");
  printKv("Node", process.version);
  printKv("zstd 可用", zstdAvailable ? "是（zlib.zstdCompressSync）" : "否（需要 Node >= 22.15）");
  printKv("默认", DEFAULT_CODEC + " L" + DEFAULT_LEVEL + "，阈值 " + DEFAULT_MIN_COMPRESS_BYTES + " B，预算 512 MB");
  process.stdout.write("\n编解码：\n");
  const rows = info.codecs.map((c) => [
    c.available ? "可用" : "不可用",
    c.name,
    c.levels.join(", ") || "-",
    c.minLevel + "-" + c.maxLevel,
    String(c.defaultLevel),
    c.note
  ]);
  process.stdout.write(renderTable(["状态", "名称", "基准等级", "等级区间", "默认", "说明"], rows) + "\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP + "\n");
    return;
  }
  const command = argv[0];
  const { flags, positional } = parseArgs(argv.slice(1));
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    return;
  }
  switch (command) {
    case "serve":
      await cmdServe(flags);
      break;
    case "bench":
      await cmdBench(flags);
      break;
    case "demo":
      await cmdDemo(flags);
      break;
    case "put":
      await cmdPut(flags, positional);
      break;
    case "get":
      await cmdGet(flags, positional);
      break;
    case "stats":
      await cmdStats(flags);
      break;
    case "info":
      await cmdInfo(flags);
      break;
    default:
      process.stderr.write("未知命令：" + command + "\n\n");
      process.stdout.write(HELP + "\n");
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write("memzip: " + (err && err.stack ? err.stack : String(err)) + "\n");
  process.exit(1);
});
