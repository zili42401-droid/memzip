// src/store.mjs — 压缩 KV 存储
//
// 语义（本项目的灵魂）：set(key, value) 把 value 压缩后存放，get(key) 透明解压返回原值，
// 调用者感知不到压缩。三条工程细节都在这里：
//   1. 压缩阈值 minCompressBytes：太小的值压缩后往往更大，直接原样存，省 CPU 也省内存；
//   2. 压缩比守卫：压缩后没有变小就存原始数据并标记 stored="raw"；
//   3. maxBytes 是"物理（压缩后）字节"预算，超了按 LRU 淘汰，物理占用恒不超过上限。

import { createHash } from "node:crypto";
import { DEFAULT_CODEC, DEFAULT_LEVEL, getCodec, hasCodec, resolveLevel } from "./codec.mjs";
import { Metrics, nowMs, round } from "./metrics.mjs";

export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MIN_COMPRESS_BYTES = 256;

function normalizeKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("key 必须是非空字符串");
  }
  if (key.length > 4096) {
    const err = new RangeError("key 过长（上限 4096 字符）");
    err.code = "KEY_TOO_LONG";
    throw err;
  }
  return key;
}

/** 把任意值编码成待压缩字节 + 类型标记。 */
export function encodeValue(value) {
  if (Buffer.isBuffer(value)) return { type: "buffer", bytes: value };
  if (value instanceof Uint8Array) return { type: "buffer", bytes: Buffer.from(value) };
  if (typeof value === "string") return { type: "string", bytes: Buffer.from(value, "utf8") };
  if (value === undefined) throw new TypeError("value 不能是 undefined");
  if (typeof value === "function") throw new TypeError("value 不能是函数");
  return { type: "json", bytes: Buffer.from(JSON.stringify(value), "utf8") };
}

/** 把解压后的字节还原成调用者最初放进来的类型。 */
export function decodeValue(type, bytes) {
  if (type === "buffer") return Buffer.from(bytes);
  if (type === "string") return bytes.toString("utf8");
  return JSON.parse(bytes.toString("utf8"));
}

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export class CompressedStore {
  constructor(options = {}) {
    this.maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : Math.max(0, Math.trunc(options.maxBytes));
    this.minCompressBytes =
      options.minCompressBytes === undefined
        ? DEFAULT_MIN_COMPRESS_BYTES
        : Math.max(0, Math.trunc(options.minCompressBytes));
    this.codec = options.codec || DEFAULT_CODEC;
    this.level = resolveLevel(this.codec, options.level === undefined ? DEFAULT_LEVEL : options.level);
    this.defaultTtlMs = Math.max(0, Math.trunc(options.defaultTtlMs || 0));
    this.allowOversize = options.allowOversize === true;
    this.metrics = options.metrics instanceof Metrics ? options.metrics : new Metrics();
    this.autoSweep = options.autoSweep !== false;
    this.sweepIntervalMs = options.sweepIntervalMs === undefined ? 1000 : options.sweepIntervalMs;

    /** key -> entry，Map 的插入顺序就是 LRU 顺序（最近使用在尾部）。 */
    this.map = new Map();
    this.physical = 0;
    this.logical = 0;
    this.sweeps = 0;
    this.lastSweepExpired = 0;
    this._lastSweepAt = 0;
  }

  get size() {
    return this.map.size;
  }

  /** 改配置；maxBytes 调小时立刻按 LRU 淘汰到位。 */
  configure(patch = {}) {
    if (patch.maxBytes !== undefined) this.maxBytes = Math.max(0, Math.trunc(patch.maxBytes));
    if (patch.minCompressBytes !== undefined) {
      this.minCompressBytes = Math.max(0, Math.trunc(patch.minCompressBytes));
    }
    if (patch.codec !== undefined) {
      if (!hasCodec(patch.codec)) throw new Error("未知编解码 " + patch.codec);
      this.codec = patch.codec;
      this.level = resolveLevel(this.codec, patch.level === undefined ? this.level : patch.level);
    } else if (patch.level !== undefined) {
      this.level = resolveLevel(this.codec, patch.level);
    }
    if (patch.defaultTtlMs !== undefined) this.defaultTtlMs = Math.max(0, Math.trunc(patch.defaultTtlMs));
    this._enforceLimit();
    return this.config();
  }

  config() {
    return {
      codec: this.codec,
      level: this.level,
      minCompressBytes: this.minCompressBytes,
      maxBytes: this.maxBytes,
      defaultTtlMs: this.defaultTtlMs,
      allowOversize: this.allowOversize,
    };
  }

  set(key, value, options = {}) {
    const k = normalizeKey(key);
    const ttlMs = options.ttlMs === undefined ? this.defaultTtlMs : Math.max(0, Math.trunc(Number(options.ttlMs) || 0));
    const { type, bytes } = encodeValue(value);
    const logicalBytes = bytes.length;
    const started = nowMs();

    let data = bytes;
    let stored = "raw";
    let codec = null;
    let level = 0;

    if (logicalBytes >= this.minCompressBytes) {
      const impl = getCodec(this.codec);
      const lv = resolveLevel(this.codec, this.level);
      const out = impl.compress(bytes, lv);
      if (out.length < logicalBytes) {
        data = out;
        stored = impl.name;
        codec = impl.name;
        level = lv;
      }
    }

    const physicalBytes = data.length;
    if (physicalBytes > this.maxBytes && !this.allowOversize) {
      const err = new RangeError(
        "单条数据物理大小 " +
          physicalBytes +
          " 字节超过 maxBytes " +
          this.maxBytes +
          " 字节；调大 --max-mb 或开启 allowOversize"
      );
      err.code = "VALUE_TOO_LARGE";
      throw err;
    }

    const previous = this.map.get(k);
    if (previous) {
      this.physical -= previous.physicalBytes;
      this.logical -= previous.logicalBytes;
      this.map.delete(k);
    }

    const now = Date.now();
    const entry = {
      key: k,
      type,
      logicalBytes,
      physicalBytes,
      data,
      codec,
      level,
      stored,
      sha256: sha256hex(bytes),
      createdAt: now,
      lastAccess: now,
      accessCount: 0,
      expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    };

    this.map.set(k, entry);
    this.physical += physicalBytes;
    this.logical += logicalBytes;
    this._enforceLimit();

    const elapsed = nowMs() - started;
    this.metrics.recordPut(logicalBytes, physicalBytes, elapsed);

    return this.meta(entry, elapsed);
  }

  /** 内部读：做过期检查 + LRU 触碰 + 指标记录，返回 { entry, buffer } 或 null。 */
  _read(key) {
    const started = nowMs();
    const k = typeof key === "string" ? key : String(key);
    const entry = this.map.get(k);
    if (!entry) {
      this.metrics.recordGet(false, 0, nowMs() - started, 0);
      return null;
    }
    if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
      this._remove(k);
      this.metrics.recordExpired(1);
      this.metrics.recordGet(false, 0, nowMs() - started, 0);
      return null;
    }
    // LRU：删掉再插回尾部
    this.map.delete(k);
    this.map.set(k, entry);
    entry.lastAccess = Date.now();
    entry.accessCount += 1;
    return { entry, started };
  }

  get(key) {
    const hit = this._read(key);
    if (!hit) return undefined;
    const { entry } = hit;
    let buffer;
    if (entry.stored === "raw") {
      buffer = Buffer.from(entry.data);
    } else {
      buffer = getCodec(entry.codec).decompress(entry.data);
    }
    const elapsed = nowMs() - hit.started;
    this.metrics.recordGet(true, entry.logicalBytes, elapsed, elapsed);
    return decodeValue(entry.type, buffer);
  }

  /** 给 HTTP 层用：拿原始字节 + 元数据，避免二次解压。 */
  fetch(key) {
    const hit = this._read(key);
    if (!hit) return null;
    const { entry } = hit;
    let buffer;
    if (entry.stored === "raw") buffer = Buffer.from(entry.data);
    else buffer = getCodec(entry.codec).decompress(entry.data);
    const elapsed = nowMs() - hit.started;
    this.metrics.recordGet(true, entry.logicalBytes, elapsed, elapsed);
    return { buffer, meta: this.meta(entry, elapsed) };
  }

  has(key) {
    const entry = this.map.get(typeof key === "string" ? key : String(key));
    if (!entry) return false;
    if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
      this._remove(entry.key);
      this.metrics.recordExpired(1);
      return false;
    }
    return true;
  }

  delete(key) {
    const k = typeof key === "string" ? key : String(key);
    const entry = this.map.get(k);
    if (!entry) return false;
    this._remove(k);
    this.metrics.recordDelete();
    return true;
  }

  clear() {
    const n = this.map.size;
    this.map.clear();
    this.physical = 0;
    this.logical = 0;
    this.metrics.recordFlush();
    return n;
  }

  meta(entry, elapsedMs) {
    return {
      key: entry.key,
      type: entry.type,
      logicalBytes: entry.logicalBytes,
      physicalBytes: entry.physicalBytes,
      ratio: entry.physicalBytes === 0 ? 0 : round(entry.logicalBytes / entry.physicalBytes, 3),
      codec: entry.codec,
      level: entry.level,
      stored: entry.stored,
      sha256: entry.sha256,
      createdAt: entry.createdAt,
      lastAccess: entry.lastAccess,
      accessCount: entry.accessCount,
      expiresAt: entry.expiresAt,
      ms: elapsedMs === undefined ? undefined : round(elapsedMs, 3),
    };
  }

  /** key 浏览器：LRU 顺序（最近使用在前），带游标分页。 */
  list(options = {}) {
    this.sweep();
    const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit === undefined ? 100 : options.limit)));
    const cursor = typeof options.cursor === "string" && options.cursor.length > 0 ? options.cursor : null;
    const keys = [...this.map.keys()].reverse();
    let start = 0;
    if (cursor) {
      const idx = keys.indexOf(cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = keys.slice(start, start + limit);
    const items = slice.map((k) => this.meta(this.map.get(k)));
    const nextCursor = start + limit < keys.length && slice.length > 0 ? slice[slice.length - 1] : null;
    return { keys: items, total: this.map.size, nextCursor, limit };
  }

  /** 惰性清理过期条目（带节流，默认最多每秒一次）。 */
  sweep(force = false) {
    if (!force && !this.autoSweep) return 0;
    const now = Date.now();
    if (!force && now - this._lastSweepAt < this.sweepIntervalMs) return 0;
    this._lastSweepAt = now;
    let removed = 0;
    for (const [k, entry] of this.map) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this._remove(k);
        removed += 1;
      }
    }
    if (removed > 0) this.metrics.recordExpired(removed);
    this.sweeps += 1;
    this.lastSweepExpired = removed;
    return removed;
  }

  _remove(key) {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.physical -= entry.physicalBytes;
    this.logical -= entry.logicalBytes;
  }

  /** 按 LRU 淘汰直到物理占用回到预算内。 */
  _enforceLimit() {
    let evicted = 0;
    while (this.physical > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this._remove(oldest.value);
      evicted += 1;
    }
    if (evicted > 0) this.metrics.recordEvictions(evicted);
    return evicted;
  }

  topCodecs() {
    const table = new Map();
    for (const entry of this.map.values()) {
      const name = entry.stored === "raw" ? "raw" : entry.codec + " L" + entry.level;
      const row = table.get(name) || { codec: name, entries: 0, logicalBytes: 0, physicalBytes: 0 };
      row.entries += 1;
      row.logicalBytes += entry.logicalBytes;
      row.physicalBytes += entry.physicalBytes;
      table.set(name, row);
    }
    return [...table.values()]
      .map((row) => ({
        ...row,
        ratio: row.physicalBytes === 0 ? 0 : round(row.logicalBytes / row.physicalBytes, 3),
      }))
      .sort((a, b) => b.physicalBytes - a.physicalBytes);
  }

  /** /api/stats 的数据源：即时量 + 累计指标。 */
  stats() {
    this.sweep();
    const m = this.metrics.snapshot();
    return {
      entries: this.map.size,
      logicalBytes: this.logical,
      physicalBytes: this.physical,
      ratio: this.physical === 0 ? 0 : round(this.logical / this.physical, 3),
      savedBytes: Math.max(0, this.logical - this.physical),
      maxBytes: this.maxBytes,
      hits: m.hits,
      misses: m.misses,
      hitRate: m.hitRate,
      evictions: m.evictions,
      expired: m.expired,
      topCodecs: this.topCodecs(),
      p50GetMs: m.p50GetMs,
      p95GetMs: m.p95GetMs,
      uptimeMs: m.uptimeMs,
      codec: this.codec,
      level: this.level,
      minCompressBytes: this.minCompressBytes,
      throughput: {
        compressMBps: m.compressMBps,
        decompressMBps: m.decompressMBps,
        opsPerSec: m.opsPerSec,
        avgPutMs: m.avgPutMs,
        p99GetMs: m.p99GetMs,
      },
      counters: {
        puts: m.puts,
        gets: m.gets,
        deletes: m.deletes,
        flushes: m.flushes,
        sweeps: this.sweeps,
        bytesIn: m.bytesIn,
        bytesStored: m.bytesStored,
      },
    };
  }
}
