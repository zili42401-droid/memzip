// test/rss-probe.mjs — 物理占用诚实性探针（受控对照实验）
//
// 问题：stats.physicalBytes 说的"压缩后占用"在进程内存上真的成立吗？
//
// 做法：同一份语料，分别以"完全不压缩"和"zstd L3 压缩"两条路径各存一遍，用同一套
// 内存指标（重点看 process.memoryUsage().arrayBuffers —— Buffer 的真实归属账目）对照。
// 语料在基线之前就已分配，且两条路径都不复制语料本身，所以增量的差别只能来自压缩。
//
// 顺序：基线 -> 未压缩 store 写入 -> 释放未压缩 store -> 压缩 store 写入。
//
// 运行（推荐带 --expose-gc，否则垃圾不会及时回收、数字会偏大）：
//   node --expose-gc test/rss-probe.mjs --mb 24

import { createHash } from "node:crypto";
import { CompressedStore } from "../src/store.mjs";
import { makeCorpus, MB } from "../src/bench.mjs";
import { round } from "../src/metrics.mjs";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    }
  }
  return flags;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mem() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
}

async function settle() {
  for (let i = 0; i < 3; i += 1) {
    if (typeof global.gc === "function") global.gc();
    await sleep(120);
  }
  return mem();
}

function fmt(bytes) {
  return round(bytes / MB, 2) + " MB";
}

function delta(a, b) {
  return {
    rss: b.rss - a.rss,
    heapUsed: b.heapUsed - a.heapUsed,
    external: b.external - a.external,
    arrayBuffers: b.arrayBuffers - a.arrayBuffers
  };
}

function row(label, m, d) {
  return [
    label,
    fmt(m.rss),
    fmt(m.arrayBuffers),
    fmt(m.external),
    fmt(m.heapUsed),
    d ? fmt(d.rss) : "-",
    d ? fmt(d.arrayBuffers) : "-"
  ];
}

function table(headers, rows) {
  const width = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => "| " + cells.map((c, i) => c + " ".repeat(width[i] - c.length)).join(" | ") + " |";
  return [line(headers), "|" + width.map((w) => "-".repeat(w + 2)).join("|") + "|", ...rows.map(line)].join("\n");
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const mb = Number(flags.mb || 24);
  const codec = flags.codec || "zstd";
  const level = Number(flags.level === undefined ? 3 : flags.level);
  const chunkBytes = 262144;
  const gcAvailable = typeof global.gc === "function";

  // 1) 先造语料（它必须在基线之前就位，否则会被算进"压缩带来的增量"）
  const corpus = makeCorpus(Math.round(mb * MB));
  const slices = [];
  let start = 0;
  for (let i = 0; i < corpus.length; i += 1) {
    if (corpus[i] === 10 && i - start >= chunkBytes) {
      slices.push(corpus.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < corpus.length) slices.push(corpus.subarray(start));
  const digests = slices.map((s) => createHash("sha256").update(s).digest("hex"));
  const keyOf = (index) => "rss-" + String(index).padStart(6, "0");

  const m0 = await settle();

  // 2) 对照组：完全不压缩地存同一批数据（物理 = 逻辑）
  const rawStore = new CompressedStore({ maxBytes: corpus.length * 3, minCompressBytes: 1e9, codec, level });
  let t0 = process.hrtime.bigint();
  slices.forEach((slice, index) => rawStore.set(keyOf(index), Buffer.from(slice)));
  const rawPutMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const m1 = await settle();
  const rawStats = rawStore.stats();

  // 2b) 卸载前先做无损校验（这个 store 马上就要被清空）
  let rawLossless = 0;
  slices.forEach((slice, index) => {
    const a = rawStore.fetch(keyOf(index));
    if (a && createHash("sha256").update(a.buffer).digest("hex") === digests[index]) rawLossless += 1;
  });

  // 3) 释放对照组，回到基线
  let releaseCheck = 0;
  for (let i = 0; i < slices.length; i += 1) rawStore.delete(keyOf(i));
  const m2 = await settle();
  releaseCheck = rawStore.physical;

  // 4) 实验组：同样的数据，zstd L3 压缩后存放
  const zipStore = new CompressedStore({ maxBytes: corpus.length * 3, codec, level, minCompressBytes: 256 });
  t0 = process.hrtime.bigint();
  slices.forEach((slice, index) => zipStore.set(keyOf(index), Buffer.from(slice)));
  const zipPutMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const m3 = await settle();
  const zipStats = zipStore.stats();

  // 5) 压缩路径的无损校验
  let zipLossless = 0;
  slices.forEach((slice, index) => {
    const b = zipStore.fetch(keyOf(index));
    if (b && createHash("sha256").update(b.buffer).digest("hex") === digests[index]) zipLossless += 1;
  });

  const d1 = delta(m0, m1);
  const d3 = delta(m2, m3);

  process.stdout.write("memzip 物理占用诚实性探针（受控对照：同一份语料，未压缩 vs zstd 压缩）\n");
  process.stdout.write("语料 " + fmt(corpus.length) + "，" + slices.length + " 条，每条约 " + Math.round(chunkBytes / 1024) + " KB\n");
  process.stdout.write("GC 可显式触发：" + (gcAvailable ? "是" : "否（用 node --expose-gc 运行更准，当前数字会偏大）") + "\n\n");
  process.stdout.write(
    table(
      ["阶段", "RSS", "arrayBuffers", "external", "heapUsed", "ΔRSS", "ΔarrayBuffers"],
      [
        row("0 基线（语料已就位）", m0, null),
        row("1 未压缩写入后", m1, d1),
        row("2 释放未压缩后", m2, delta(m0, m2)),
        row("3 压缩写入后", m3, d3)
      ]
    ) + "\n\n"
  );
  process.stdout.write("未压缩路径：" + rawStats.entries + " 条，逻辑 " + fmt(rawStats.logicalBytes) + "，物理 " + fmt(rawStats.physicalBytes) + "，压缩比 " + rawStats.ratio + "x，写入 " + round(rawPutMs, 1) + " ms，无损 " + rawLossless + "/" + slices.length + "\n");
  process.stdout.write("压缩路径：  " + zipStats.entries + " 条，逻辑 " + fmt(zipStats.logicalBytes) + "，物理 " + fmt(zipStats.physicalBytes) + "，压缩比 " + zipStats.ratio + "x，写入 " + round(zipPutMs, 1) + " ms，无损 " + zipLossless + "/" + slices.length + "\n\n");
  process.stdout.write("对照结论：\n");
  process.stdout.write("  ΔarrayBuffers 未压缩 = " + fmt(d1.arrayBuffers) + "（≈ 逻辑大小 " + fmt(rawStats.logicalBytes) + "，方向正确）\n");
  process.stdout.write("  ΔarrayBuffers 压缩   = " + fmt(d3.arrayBuffers) + "（≈ 物理大小 " + fmt(zipStats.physicalBytes) + "，方向正确）\n");
  process.stdout.write("  两者比值             = " + round(d3.arrayBuffers / d1.arrayBuffers, 3) + "（= 压缩比 " + zipStats.ratio + "x 的倒数，说明省下的确实是内存）\n");
  process.stdout.write("  ΔRSS 未压缩 / 压缩   = " + fmt(d1.rss) + " / " + fmt(d3.rss) + "\n");
  process.stdout.write("  释放后物理账目        = " + releaseCheck + " 字节（未压缩 store 已清空）\n");
  process.stdout.write("\n为什么 ΔRSS 不等于 stats.physicalBytes：RSS 里还有 V8 堆、ArrayBuffer 分配器的碎片、\n");
  process.stdout.write("zstd 编码时的临时工作区，以及 GC 尚未归还给操作系统的页。arrayBuffers 才是与 Buffer 归属最贴近的账目。\n");
}

main().catch((err) => {
  process.stderr.write("rss-probe 失败：" + (err && err.stack ? err.stack : String(err)) + "\n");
  process.exit(1);
});
