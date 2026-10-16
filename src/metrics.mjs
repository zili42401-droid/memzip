// src/metrics.mjs — 指标采集
//
// 只负责"累计计数 + 延迟分位 + 吞吐"，即时量（逻辑/物理占用、条目数）由 store 提供，
// 两边在 store.stats() 里汇总成 HTTP 契约里的 /api/stats 对象。

const LATENCY_CAP = 8192;
const RATE_WINDOW_MS = 10000;

export function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

export function round(value, digits) {
  const f = Math.pow(10, digits === undefined ? 3 : digits);
  return Math.round(value * f) / f;
}

/** 升序数组上的线性插值分位。 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function mbPerSec(bytes, ms) {
  if (!(ms > 0) || !(bytes > 0)) return 0;
  return bytes / 1e6 / (ms / 1000);
}

export class Metrics {
  constructor(options = {}) {
    this.startedAt = Date.now();
    this.label = options.label || "memzip";

    // 命中 / 未命中
    this.hits = 0;
    this.misses = 0;
    this.gets = 0;

    // 写入与失效
    this.puts = 0;
    this.deletes = 0;
    this.evictions = 0;
    this.expired = 0;
    this.flushes = 0;

    // 累计字节与耗时（用于吞吐）
    this.compressedIn = 0;
    this.compressedOut = 0;
    this.decompressedOut = 0;
    this.compressMs = 0;
    this.decompressMs = 0;

    // get 延迟环形缓冲
    this.latencies = new Float64Array(LATENCY_CAP);
    this.latencyCount = 0;
    this.latencyCursor = 0;

    // 滑窗速率
    this.ops = [];
  }

  recordPut(logicalBytes, physicalBytes, ms) {
    this.puts += 1;
    this.compressedIn += logicalBytes;
    this.compressedOut += physicalBytes;
    this.compressMs += ms;
    this._pushOp("put");
  }

  recordGet(hit, logicalBytes, ms, decompressMs) {
    this.gets += 1;
    if (hit) this.hits += 1;
    else this.misses += 1;
    if (hit) {
      this.decompressMs += decompressMs;
      this.decompressedOut += logicalBytes;
    }
    this._pushLatency(ms);
    this._pushOp("get");
  }

  recordExpired(count) {
    this.expired += count;
  }

  recordEvictions(count) {
    this.evictions += count;
  }

  recordDelete() {
    this.deletes += 1;
  }

  recordFlush() {
    this.flushes += 1;
  }

  _pushLatency(ms) {
    this.latencies[this.latencyCursor] = ms;
    this.latencyCursor = (this.latencyCursor + 1) % LATENCY_CAP;
    if (this.latencyCount < LATENCY_CAP) this.latencyCount += 1;
  }

  _pushOp(kind) {
    const t = Date.now();
    this.ops.push(t);
    if (this.ops.length > 4096) this.ops.splice(0, this.ops.length - 4096);
    return t;
  }

  latencySamples() {
    const out = [];
    for (let i = 0; i < this.latencyCount; i += 1) out.push(this.latencies[i]);
    out.sort((a, b) => a - b);
    return out;
  }

  opsPerSec() {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (this.ops.length > 0 && this.ops[0] < cutoff) this.ops.shift();
    return this.ops.length / (RATE_WINDOW_MS / 1000);
  }

  get hitRate() {
    return this.gets === 0 ? 0 : this.hits / this.gets;
  }

  get p50GetMs() {
    return round(percentile(this.latencySamples(), 0.5), 3);
  }

  get p95GetMs() {
    return round(percentile(this.latencySamples(), 0.95), 3);
  }

  get p99GetMs() {
    return round(percentile(this.latencySamples(), 0.99), 3);
  }

  get putLatency() {
    return this.puts === 0 ? 0 : round(this.compressMs / this.puts, 3);
  }

  get compressMBps() {
    return round(mbPerSec(this.compressedIn, this.compressMs), 1);
  }

  get decompressMBps() {
    return round(mbPerSec(this.decompressedOut, this.decompressMs), 1);
  }

  /** 汇总：store 会把即时量（entries/logicalBytes/...）合并进来。 */
  snapshot() {
    return {
      hits: this.hits,
      misses: this.misses,
      gets: this.gets,
      hitRate: round(this.hitRate, 4),
      puts: this.puts,
      deletes: this.deletes,
      evictions: this.evictions,
      expired: this.expired,
      flushes: this.flushes,
      uptimeMs: Date.now() - this.startedAt,
      p50GetMs: this.p50GetMs,
      p95GetMs: this.p95GetMs,
      p99GetMs: this.p99GetMs,
      avgPutMs: this.putLatency,
      compressMBps: this.compressMBps,
      decompressMBps: this.decompressMBps,
      opsPerSec: round(this.opsPerSec(), 2),
      bytesIn: this.compressedIn,
      bytesStored: this.compressedOut,
    };
  }

  reset() {
    this.hits = 0;
    this.misses = 0;
    this.gets = 0;
    this.puts = 0;
    this.deletes = 0;
    this.evictions = 0;
    this.expired = 0;
    this.compressedIn = 0;
    this.compressedOut = 0;
    this.decompressedOut = 0;
    this.compressMs = 0;
    this.decompressMs = 0;
    this.latencies = new Float64Array(LATENCY_CAP);
    this.latencyCount = 0;
    this.latencyCursor = 0;
    this.ops = [];
    this.startedAt = Date.now();
  }
}
