// test/smoke.mjs — 自检（自带迷你断言运行器，输出 PASS/FAIL 行）
//
// 运行：node test/smoke.mjs
// 末行固定为 "<n> passed, <m> failed"，有 FAIL 时退出码 1。

import assert from "node:assert/strict";
import { CompressedStore, encodeValue } from "../src/store.mjs";
import { codecInfo, getCodec, resolveLevel } from "../src/codec.mjs";
import { decodeZstdFrames, makeCorpus } from "../src/bench.mjs";
import { startServer } from "../src/server.mjs";
import zlib from "node:zlib";

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBuffer(bytes) {
  const buf = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i += 1) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

// ---------------------------------------------------------------- 往返

test("往返-string", () => {
  const store = new CompressedStore({ maxBytes: 1e6 });
  const text = "中文字符串与 English mixed — ".repeat(400);
  const info = store.set("s", text);
  assert.equal(info.stored, "zstd", "长字符串应该走压缩路径");
  assert.equal(store.get("s"), text);
  assert.equal(store.get("s").length, text.length);
});

test("往返-buffer（逐字节一致）", () => {
  const store = new CompressedStore({ maxBytes: 8e6 });
  const payload = Buffer.concat([makeCorpus(200000), randomBuffer(20000)]);
  store.set("b", payload);
  const back = store.get("b");
  assert.ok(Buffer.isBuffer(back), "get 应该返回 Buffer");
  assert.equal(Buffer.compare(back, payload), 0, "Buffer.compare 必须为 0");
});

test("往返-json 对象", () => {
  const store = new CompressedStore({ maxBytes: 1e6 });
  const value = { name: "memzip", nested: { list: [1, 2, 3], deep: { ok: true } }, text: "压缩内存" };
  store.set("j", value);
  assert.deepEqual(store.get("j"), value);
});

test("往返-小字符串与数字/布尔", () => {
  const store = new CompressedStore({ maxBytes: 1e6 });
  store.set("n", 42);
  store.set("t", true);
  store.set("null", null);
  assert.equal(store.get("n"), 42);
  assert.equal(store.get("t"), true);
  assert.equal(store.get("null"), null);
});

// ---------------------------------------------------------------- 阈值与守卫

test("阈值-小于 minCompressBytes 走 raw", () => {
  const store = new CompressedStore({ maxBytes: 1e6, minCompressBytes: 256 });
  const small = "tiny value";
  const info = store.set("small", small);
  assert.equal(info.stored, "raw", "短值不应压缩");
  assert.equal(info.logicalBytes, info.physicalBytes, "raw 存储时逻辑=物理");
  assert.equal(store.get("small"), small);

  const big = store.set("big", "repeat me ".repeat(500));
  assert.equal(big.codec, "zstd", "超过阈值的值应压缩");
  assert.ok(big.physicalBytes < big.logicalBytes);
});

test("阈值-minCompressBytes=0 时连小值也尝试压缩", () => {
  const store = new CompressedStore({ maxBytes: 1e6, minCompressBytes: 0 });
  const info = store.set("k", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(info.stored, "zstd");
});

test("比值守卫-不可压缩数据不被压缩变大", () => {
  const store = new CompressedStore({ maxBytes: 8e6, minCompressBytes: 256 });
  const noise = randomBuffer(262144);
  const info = store.set("noise", noise);
  assert.equal(info.stored, "raw", "随机字节应被守卫拦截为 raw");
  assert.ok(info.physicalBytes <= info.logicalBytes, "物理占用不能超过原始大小");
  assert.equal(Buffer.compare(store.get("noise"), noise), 0);
});

// ---------------------------------------------------------------- LRU / 预算

test("LRU-超预算淘汰最旧且物理占用不越界", () => {
  const store = new CompressedStore({ maxBytes: 200000, minCompressBytes: 64 });
  const chunk = makeCorpus(60000);
  const keys = [];
  for (let i = 0; i < 30; i += 1) {
    const key = "lru-" + String(i).padStart(3, "0");
    store.set(key, Buffer.concat([chunk, Buffer.from(" 序号 " + i)]));
    keys.push(key);
    assert.ok(store.physical <= store.maxBytes, "物理占用不得超过 maxBytes（第 " + i + " 次写入后）");
  }
  const stats = store.stats();
  assert.ok(stats.evictions > 0, "应该发生淘汰");
  assert.equal(store.get(keys[0]), undefined, "最早的 key 应被淘汰");
  assert.notEqual(store.get(keys[keys.length - 1]), undefined, "最新的 key 应还在");
  assert.ok(store.physical <= store.maxBytes);
  assert.equal(store.stats().physicalBytes, store.physical, "stats 的物理占用要等于真实账目");
});

test("LRU-重复访问会改变淘汰顺序（最近使用在尾部）", () => {
  const store = new CompressedStore({ maxBytes: 90000, minCompressBytes: 32 });
  // 用不可压缩的随机字节，保证每条物理占用就是 30000 字节（可压缩数据在这里会失真）
  const body = randomBuffer(30000);
  store.set("a", Buffer.from(body));
  store.set("b", Buffer.from(body));
  store.set("c", Buffer.from(body));
  assert.notEqual(store.get("a"), undefined);
  store.set("d", Buffer.from(body));
  assert.notEqual(store.get("a"), undefined, "刚访问过的 a 不应该被淘汰");
  assert.equal(store.get("b"), undefined, "最久未使用的 b 应该被淘汰");
});

test("预算-单条超预算默认拒绝", () => {
  const store = new CompressedStore({ maxBytes: 1000, minCompressBytes: 32 });
  assert.throws(() => {
    store.set("huge", randomBuffer(50000));
  }, /maxBytes/);
  assert.equal(store.size, 0, "被拒绝的写入不应留下数据");
});

test("预算-configure 调小 maxBytes 立即淘汰到位", () => {
  const store = new CompressedStore({ maxBytes: 5e6, minCompressBytes: 32 });
  for (let i = 0; i < 8; i += 1) store.set("c" + i, "compressible ".repeat(30000));
  assert.ok(store.physical <= 5e6);
  store.configure({ maxBytes: 500000 });
  assert.ok(store.physical <= 500000, "configure 之后物理占用必须立刻回到新预算内");
});

// ---------------------------------------------------------------- TTL

test("TTL-过期后 get 返回 undefined", async () => {
  const store = new CompressedStore({ maxBytes: 1e6, defaultTtlMs: 40 });
  store.set("temp", "短命的数据 ".repeat(50));
  assert.notEqual(store.get("temp"), undefined, "过期前应能读到");
  await sleep(80);
  assert.equal(store.get("temp"), undefined, "过期后应为 undefined");
  assert.equal(store.has("temp"), false);
  assert.ok(store.stats().expired >= 1, "过期计数应该增加");
});

test("TTL-每条数据可以有自己的 ttlMs", async () => {
  const store = new CompressedStore({ maxBytes: 1e6 });
  store.set("forever", "长期数据 ".repeat(50));
  store.set("short", "短期数据 ".repeat(50), { ttlMs: 30 });
  await sleep(60);
  assert.notEqual(store.get("forever"), undefined);
  assert.equal(store.get("short"), undefined);
});

// ---------------------------------------------------------------- 并发与鲁棒性

test("并发-100 个并发 put/get 不串数据", async () => {
  const store = new CompressedStore({ maxBytes: 64e6, minCompressBytes: 32 });
  const jobs = [];
  for (let i = 0; i < 100; i += 1) {
    const key = "con-" + i;
    const payload = "payload-" + i + "-" + "数据块".repeat(2000 + i) + "-" + i;
    jobs.push(
      (async () => {
        await Promise.resolve();
        store.set(key, payload);
        await Promise.resolve();
        const back = store.get(key);
        assert.equal(back, payload, key + " 读回的值必须一致");
        return true;
      })()
    );
  }
  const done = await Promise.all(jobs);
  assert.equal(done.length, 100);
  assert.equal(store.size, 100);
  for (let i = 0; i < 100; i += 1) {
    assert.ok(store.get("con-" + i).startsWith("payload-" + i + "-"));
  }
});

test("崩溃安全-读不存在的 key 返回 undefined 不抛", () => {
  const store = new CompressedStore({ maxBytes: 1e6 });
  assert.equal(store.get("never-existed"), undefined);
  assert.equal(store.fetch("never-existed"), null);
  assert.equal(store.has("never-existed"), false);
  assert.equal(store.delete("never-existed"), false);
  assert.equal(store.stats().misses, 2, "get 与 fetch 的两次未命中都要计数");
});

test("崩溃安全-非法 key 抛错而不是静默写入", () => {
  const store = new CompressedStore({ maxBytes: 1e6 });
  assert.throws(() => store.set("", "x"), /key/);
  assert.throws(() => store.set(null, "x"), /key/);
  assert.throws(() => store.set("k", undefined), /undefined/);
});

// ---------------------------------------------------------------- 指标

test("指标-logical/physical/ratio 与实际一致", () => {
  const store = new CompressedStore({ maxBytes: 8e6, minCompressBytes: 256 });
  const a = "可压缩文本 ".repeat(1000);
  const b = randomBuffer(4096);
  const ia = store.set("m-a", a);
  const ib = store.set("m-b", b);
  const stats = store.stats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.logicalBytes, ia.logicalBytes + ib.logicalBytes);
  assert.equal(stats.physicalBytes, ia.physicalBytes + ib.physicalBytes);
  assert.equal(stats.logicalBytes, Buffer.byteLength(a, "utf8") + 4096);
  const expectedRatio = Math.round((stats.logicalBytes / stats.physicalBytes) * 1000) / 1000;
  assert.equal(stats.ratio, expectedRatio);
  assert.equal(stats.savedBytes, stats.logicalBytes - stats.physicalBytes);
  assert.equal(stats.hits, 0);
  store.get("m-a");
  store.get("nope");
  const after = store.stats();
  assert.equal(after.hits, 1);
  assert.equal(after.misses, 1);
  assert.equal(after.hitRate, 0.5);
  assert.ok(after.p95GetMs >= 0 && after.p50GetMs >= 0);
});

test("指标-delete/clear 会同步减少占用", () => {
  const store = new CompressedStore({ maxBytes: 8e6 });
  store.set("x", "内容 ".repeat(500));
  store.set("y", "内容 ".repeat(500));
  assert.equal(store.delete("x"), true);
  assert.equal(store.stats().entries, 1);
  assert.equal(store.clear(), 1);
  const stats = store.stats();
  assert.equal(stats.entries, 0);
  assert.equal(stats.logicalBytes, 0);
  assert.equal(stats.physicalBytes, 0);
  assert.equal(stats.ratio, 0);
});

// ---------------------------------------------------------------- 编解码

test("编解码-四个内置编解码都能无损往返", () => {
  const corpus = makeCorpus(150000);
  const names = codecInfo().filter((c) => c.available).map((c) => c.name);
  assert.ok(names.includes("zstd"), "本机应有 zstd");
  for (const name of names) {
    const store = new CompressedStore({ maxBytes: 8e6, codec: name, level: 3, minCompressBytes: 256 });
    const info = store.set("k", corpus);
    assert.equal(info.codec, name, name + " 应该被真正使用");
    assert.equal(Buffer.compare(store.get("k"), corpus), 0, name + " 往返必须无损");
  }
});

test("编解码-等级会被夹到合法区间", () => {
  assert.equal(resolveLevel("zstd", 999), 22);
  assert.equal(resolveLevel("zstd", -5), 1);
  assert.equal(resolveLevel("gzip", 99), 9);
  assert.equal(resolveLevel("brotli", "abc"), 6);
  assert.throws(() => getCodec("nope"), /未知编解码/);
});

test("编解码-多帧 zstd 语料解码（真会话日志的存储格式）", () => {
  const parts = [makeCorpus(20000, 1), makeCorpus(30000, 2), makeCorpus(5000, 3)];
  const frames = parts.map((p) => zlib.zstdCompressSync(p));
  const joined = Buffer.concat(frames);
  const decoded = decodeZstdFrames(joined);
  assert.equal(Buffer.compare(decoded, Buffer.concat(parts)), 0, "多帧解码必须拼回原文");
  assert.ok(zlib.zstdDecompressSync(joined).length < decoded.length, "单次调用确实只解出第一帧（这就是要逐帧的理由）");
});

// ---------------------------------------------------------------- HTTP

test("HTTP-完整往返（5 MB 混合数据逐字节一致）", async () => {
  const running = await startServer({ port: 0, maxBytes: 64e6, codec: "zstd", level: 3 });
  try {
    const mixed = Buffer.concat([randomBuffer(2500000), makeCorpus(2500000)]);
    const url = running.url;

    const putRes = await fetch(url + "/api/kv?key=mixed", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: mixed
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.key, "mixed");
    assert.equal(putBody.logicalBytes, mixed.length);
    assert.ok(putBody.physicalBytes < mixed.length, "混合数据应该被压缩");

    const getRes = await fetch(url + "/api/kv/mixed");
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get("content-type"), "application/octet-stream");
    assert.equal(getRes.headers.get("cache-control"), "no-store");
    const got = Buffer.from(await getRes.arrayBuffer());
    assert.equal(got.length, mixed.length, "取回字节数必须相同");
    assert.equal(Buffer.compare(got, mixed), 0, "Buffer.compare 必须为 0");

    const statsRes = await fetch(url + "/api/stats");
    const stats = await statsRes.json();
    assert.equal(stats.entries, 1);
    assert.equal(stats.logicalBytes, mixed.length);
    assert.equal(stats.hits, 1);
    assert.ok(stats.ratio > 1);

    const missing = await fetch(url + "/api/kv/nope");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("content-type"), "application/json; charset=utf-8");
    const errBody = await missing.json();
    assert.equal(errBody.error.code, "NOT_FOUND");

    const del = await fetch(url + "/api/kv/mixed", { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, true);

    const page = await (await fetch(url + "/api/keys?limit=10")).json();
    assert.equal(page.keys.length, 0);

    const bench = await (
      await fetch(url + "/api/bench", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mb: 1 })
      })
    ).json();
    assert.ok(bench.results.length >= 4, "bench 应返回多条结果");
    assert.equal(bench.lossless, true);

    const index = await fetch(url + "/");
    assert.equal(index.status, 200);
    assert.ok((await index.text()).includes("memzip"));

    const traversal = await fetch(url + "/../package.json");
    assert.ok(traversal.status === 403 || traversal.status === 404, "路径穿越必须被挡住");
  } finally {
    await running.close();
  }
});

test("HTTP-JSON 写入 + base64 二进制往返", async () => {
  const running = await startServer({ port: 0, maxBytes: 16e6 });
  try {
    const url = running.url;
    const wide = "宽字符文本与 emoji 🐟 混合 ".repeat(500);
    const r1 = await fetch(url + "/api/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "text", value: wide })
    });
    assert.equal(r1.status, 200);
    const gotText = Buffer.from(await (await fetch(url + "/api/kv/text")).arrayBuffer()).toString("utf8");
    assert.equal(gotText, wide);

    const bin = randomBuffer(300000);
    const r2 = await fetch(url + "/api/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "bin", value: bin.toString("base64"), encoding: "base64" })
    });
    assert.equal(r2.status, 200);
    const gotBin = Buffer.from(await (await fetch(url + "/api/kv/bin")).arrayBuffer());
    assert.equal(Buffer.compare(gotBin, bin), 0);

    const bad = await fetch(url + "/api/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "no key" })
    });
    assert.equal(bad.status, 400);

    const flush = await fetch(url + "/api/flush", { method: "POST" });
    assert.equal((await flush.json()).flushed, 2);
  } finally {
    await running.close();
  }
});

test("HTTP-超预算写入返回 413 而不是 500", async () => {
  const running = await startServer({ port: 0, maxBytes: 100000, minCompressBytes: 64 });
  try {
    const res = await fetch(running.url + "/api/kv?key=too-big", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: randomBuffer(500000)
    });
    assert.equal(res.status, 413, "超预算应回 413");
    const body = await res.json();
    assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
    assert.equal(running.store.size, 0, "被拒绝的写入不能留下数据");

    const longKey = await fetch(running.url + "/api/kv?key=" + "k".repeat(5000), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("tiny")
    });
    assert.equal(longKey.status, 400, "超长 key 应回 400");
  } finally {
    await running.close();
  }
});

// ---------------------------------------------------------------- 运行器

async function main() {
  let passed = 0;
  let failed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      process.stdout.write("PASS " + item.name + "\n");
    } catch (err) {
      failed += 1;
      const reason = err && err.message ? err.message : String(err);
      process.stdout.write("FAIL " + item.name + " - " + reason.split("\n")[0] + "\n");
    }
  }
  process.stdout.write(passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exitCode = 1;
}

main();
