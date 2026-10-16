// web/app.js — memzip 面板前端（原生 JS，零框架、零 CDN）
// 约定：所有文本都用 textContent 写入，绝不拼 innerHTML。

'use strict';

var POLL_MS = 1000;
var HISTORY_MAX = 180;

var state = {
  history: [],
  maxBytes: 0,
  codec: 'zstd',
  level: 3,
  cursor: null,
  keyCount: 0
};

function byId(id) { return document.getElementById(id); }

function setText(id, text) {
  var el = byId(id);
  if (el) el.textContent = String(text);
}

function fmtBytes(n) {
  if (!isFinite(n)) return '—';
  if (n < 1000) return n + ' B';
  if (n < 1000000) return (n / 1000).toFixed(1) + ' KB';
  if (n < 1000000000) return (n / 1000000).toFixed(2) + ' MB';
  return (n / 1000000000).toFixed(2) + ' GB';
}

function fmtInt(n) {
  if (!isFinite(n)) return '—';
  return Number(n).toLocaleString('en-US');
}

function ratioClass(ratio) {
  if (ratio >= 3) return 'ratio-good';
  if (ratio >= 1.5) return 'ratio-mid';
  return 'ratio-bad';
}

async function getJson(url, options) {
  var res = await fetch(url, options);
  var text = await res.text();
  var body = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch (err) { body = null; }
  }
  if (!res.ok) {
    var message = body && body.error ? body.error.message : ('HTTP ' + res.status);
    throw new Error(message);
  }
  return body;
}

function setStatus(ok, text) {
  var dot = byId('status-dot');
  dot.className = 'dot ' + (ok ? 'ok' : 'err');
  setText('status-text', text);
}

function addCell(tr, text, className) {
  var td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  tr.appendChild(td);
  return td;
}

function render(stats) {
  state.maxBytes = stats.maxBytes;
  state.codec = stats.codec;
  state.level = stats.level;

  setText('v-ratio', stats.ratio.toFixed(2) + 'x');
  byId('v-ratio').className = 'card-value ' + ratioClass(stats.ratio);
  setText('s-ratio', '逻辑 ' + fmtBytes(stats.logicalBytes) + ' ÷ 物理 ' + fmtBytes(stats.physicalBytes));

  setText('v-saved', fmtBytes(stats.savedBytes));
  setText('s-saved', '省下 ' + (stats.physicalBytes > 0 ? (stats.savedBytes / 1048576).toFixed(1) : '0') + ' MB');

  setText('v-logical', fmtBytes(stats.logicalBytes));
  setText('s-logical', fmtInt(stats.logicalBytes) + ' 字节');

  setText('v-physical', fmtBytes(stats.physicalBytes));
  setText('s-physical', '预算 ' + fmtBytes(stats.maxBytes) + '（' + (stats.maxBytes > 0 ? (stats.physicalBytes / stats.maxBytes * 100).toFixed(1) : '0') + '%）');

  setText('m-hitrate', (stats.hitRate * 100).toFixed(1) + '%');
  setText('m-hits', fmtInt(stats.hits) + ' / ' + fmtInt(stats.misses));
  setText('m-entries', fmtInt(stats.entries));
  setText('m-evict', fmtInt(stats.evictions) + ' / ' + fmtInt(stats.expired));
  setText('m-latency', 'p50 ' + stats.p50GetMs + ' ms，p95 ' + stats.p95GetMs + ' ms');
  setText('m-cput', stats.throughput.compressMBps + ' MB/s');
  setText('m-dput', stats.throughput.decompressMBps + ' MB/s');
  setText('m-uptime', (stats.uptimeMs / 1000).toFixed(0) + ' s');
  setText('m-codec', stats.codec + ' L' + stats.level + '（阈值 ' + stats.minCompressBytes + ' B）');

  state.history.push({ logical: stats.logicalBytes, physical: stats.physicalBytes });
  while (state.history.length > HISTORY_MAX) state.history.shift();
  drawChart();

  setText('status-config', '物理预算 ' + fmtBytes(stats.maxBytes) + ' · ' + stats.codec + ' L' + stats.level);
}

function drawChart() {
  var canvas = byId('chart');
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var cssWidth = canvas.clientWidth || 600;
  var cssHeight = 220;
  if (canvas.width !== Math.round(cssWidth * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  var pad = { left: 56, right: 12, top: 12, bottom: 20 };
  var plotW = cssWidth - pad.left - pad.right;
  var plotH = cssHeight - pad.top - pad.bottom;

  // 纵轴按数据自身缩放：预算线只在它落在可见范围内时才画，
  // 否则一条 512 MB 的预算线会把几 MB 的曲线压成地板上的直线。
  var dataMax = 0;
  var i;
  for (i = 0; i < state.history.length; i += 1) {
    dataMax = Math.max(dataMax, state.history[i].logical, state.history[i].physical);
  }
  var maxValue = Math.max(dataMax * 1.15, 1);
  var showBudget = state.maxBytes > 0 && state.maxBytes <= maxValue;

  ctx.strokeStyle = '#24313d';
  ctx.fillStyle = '#8b9bab';
  ctx.font = '10px system-ui, sans-serif';
  ctx.lineWidth = 1;
  var rows = 4;
  for (i = 0; i <= rows; i += 1) {
    var y = pad.top + (plotH * i) / rows;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(fmtBytes((maxValue * (rows - i)) / rows), 6, y + 3);
  }

  if (showBudget) {
    var budgetY = pad.top + plotH - (state.maxBytes / maxValue) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, budgetY);
    ctx.lineTo(pad.left + plotW, budgetY);
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = '#f87171';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f87171';
    ctx.fillText('预算 ' + fmtBytes(state.maxBytes), pad.left + 6, budgetY - 4);
  }

  if (state.history.length === 0) {
    ctx.fillText('等待数据…', pad.left + 8, pad.top + 16);
    return;
  }

  var step = state.history.length > 1 ? plotW / (state.history.length - 1) : plotW;
  function xAt(index) { return pad.left + step * index; }
  function yAt(value) { return pad.top + plotH - (value / maxValue) * plotH; }

  // 物理占用：填充区域 + 折线
  ctx.beginPath();
  ctx.moveTo(xAt(0), pad.top + plotH);
  for (i = 0; i < state.history.length; i += 1) ctx.lineTo(xAt(i), yAt(state.history[i].physical));
  ctx.lineTo(xAt(state.history.length - 1), pad.top + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(76, 201, 240, 0.16)';
  ctx.fill();

  ctx.beginPath();
  for (i = 0; i < state.history.length; i += 1) {
    var px = xAt(i);
    var py = yAt(state.history[i].physical);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = '#4cc9f0';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 逻辑占用：虚线参考
  ctx.beginPath();
  for (i = 0; i < state.history.length; i += 1) {
    var lx = xAt(i);
    var ly = yAt(state.history[i].logical);
    if (i === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
  }
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#8b9bab';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  var last = state.history[state.history.length - 1];
  ctx.fillStyle = '#4cc9f0';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('物理 ' + fmtBytes(last.physical), pad.left + 6, pad.top + 12);
  ctx.fillStyle = '#8b9bab';
  ctx.fillText('逻辑 ' + fmtBytes(last.logical), pad.left + 6, pad.top + 26);
  ctx.fillText('样本 ' + state.history.length + ' / ' + HISTORY_MAX, pad.left + plotW - 88, pad.top + 12);
}

async function poll() {
  try {
    var stats = await getJson('/api/stats');
    render(stats);
    setStatus(true, '已连接');
  } catch (err) {
    setStatus(false, '连接失败：' + err.message);
  }
}

async function runBench() {
  var mb = Number(byId('bench-mb').value) || 8;
  byId('btn-bench').disabled = true;
  setText('bench-log', '正在跑 ' + mb + ' MB 语料的基准…');
  try {
    var data = await getJson('/api/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mb: mb })
    });
    renderBench(data);
    setText('bench-log', '语料 ' + data.mb + ' MB（' + fmtInt(data.inputBytes) + ' 字节），无损校验：' + (data.lossless ? '全部通过' : '存在失败项'));
  } catch (err) {
    setText('bench-log', '基准失败：' + err.message);
  }
  byId('btn-bench').disabled = false;
}

function renderBench(data) {
  var body = byId('bench-body');
  body.textContent = '';
  data.results.forEach(function (row) {
    var tr = document.createElement('tr');
    if (row.codec === data.current.codec) tr.className = 'current';
    addCell(tr, row.label);
    addCell(tr, (row.compressedBytes / 1000000).toFixed(2) + ' MB');
    addCell(tr, row.ratio.toFixed(2) + 'x', ratioClass(row.ratio));
    addCell(tr, String(row.compressMBps));
    addCell(tr, String(row.decompressMBps));
    body.appendChild(tr);
  });
  byId('keys-note').textContent = 'GET /api/keys';
}

async function loadKeys(reset) {
  if (reset) { state.cursor = null; byId('keys-body').textContent = ''; }
  var url = '/api/keys?limit=50';
  if (state.cursor) url += '&cursor=' + encodeURIComponent(state.cursor);
  try {
    var page = await getJson(url);
    renderKeys(page, reset);
  } catch (err) {
    setText('keys-total', '加载失败：' + err.message);
  }
}

function renderKeys(page, reset) {
  var body = byId('keys-body');
  if (reset) body.textContent = '';
  if (page.keys.length === 0 && body.childElementCount === 0) {
    var empty = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'muted';
    cell.textContent = '暂无数据';
    empty.appendChild(cell);
    body.appendChild(empty);
  }
  page.keys.forEach(function (item) {
    var tr = document.createElement('tr');
    addCell(tr, item.key);
    addCell(tr, fmtBytes(item.logicalBytes));
    addCell(tr, fmtBytes(item.physicalBytes));
    addCell(tr, item.ratio.toFixed(2) + 'x', ratioClass(item.ratio));
    addCell(tr, item.stored === 'raw' ? 'raw' : item.codec + ' L' + item.level);
    var actions = document.createElement('td');
    var readBtn = document.createElement('button');
    readBtn.textContent = '读取';
    readBtn.addEventListener('click', function () { readKey(item.key); });
    var delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.className = 'danger';
    delBtn.addEventListener('click', function () { deleteKey(item.key); });
    actions.appendChild(readBtn);
    actions.appendChild(delBtn);
    tr.appendChild(actions);
    body.appendChild(tr);
  });
  state.cursor = page.nextCursor;
  state.keyCount = page.total;
  byId('btn-more').disabled = !page.nextCursor;
  setText('keys-total', '共 ' + page.total + ' 条' + (page.nextCursor ? '（还有更多）' : ''));
}

async function readKey(key) {
  try {
    var res = await fetch('/api/kv/' + encodeURIComponent(key));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var type = res.headers.get('x-memzip-value-type');
    var ratio = res.headers.get('x-memzip-ratio');
    var buf = await res.arrayBuffer();
    byId('put-key').value = key;
    if (type === 'string' || type === 'json') {
      byId('put-value').value = new TextDecoder().decode(buf);
      setText('put-log', '已读取 ' + key + '：' + fmtBytes(buf.byteLength) + '，单条压缩比 ' + ratio + 'x');
    } else {
      setText('put-log', '已读取 ' + key + '：二进制 ' + fmtBytes(buf.byteLength) + '，单条压缩比 ' + ratio + 'x（不可当文本编辑）');
    }
  } catch (err) {
    setText('put-log', '读取失败：' + err.message);
  }
}

async function deleteKey(key) {
  try {
    await getJson('/api/kv/' + encodeURIComponent(key), { method: 'DELETE' });
    setText('put-log', '已删除 ' + key);
    loadKeys(true);
    poll();
  } catch (err) {
    setText('put-log', '删除失败：' + err.message);
  }
}

async function doPut() {
  var key = byId('put-key').value.trim();
  var value = byId('put-value').value;
  if (key.length === 0) { setText('put-log', 'key 不能为空'); return; }
  try {
    var info = await getJson('/api/kv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, value: value })
    });
    setText('put-log', '写入 ' + info.key + '：' + fmtBytes(info.logicalBytes) + ' -> ' + fmtBytes(info.physicalBytes) + '（' + info.ratio + 'x，stored=' + info.stored + '）');
    loadKeys(true);
    poll();
  } catch (err) {
    setText('put-log', '写入失败：' + err.message);
  }
}

function buildBlob(bytes) {
  var parts = [];
  var size = 0;
  var encoder = new TextEncoder();
  var i = 0;
  while (size < bytes) {
    i += 1;
    var line = JSON.stringify({
      t: new Date().toISOString(),
      seq: i,
      role: i % 3 === 0 ? 'tool' : 'assistant',
      text: 'memzip 面板生成的测试数据：重复的 JSON 结构让压缩比更接近真实语料。第 ' + i + ' 行。'
    });
    parts.push(line);
    size += encoder.encode(line).length + 1;
  }
  return parts.join(String.fromCharCode(10));
}

async function generate() {
  var mb = Number(byId('gen-mb').value) || 1;
  var target = mb * 1000000;
  var chunkBytes = 500000;
  byId('btn-gen').disabled = true;
  setText('put-log', '正在生成并写入 ' + mb + ' MB…');
  try {
    var blob = buildBlob(target);
    var encoder = new TextEncoder();
    var written = 0;
    var index = 0;
    var offset = 0;
    while (offset < blob.length) {
      var end = offset;
      var bytes = 0;
      while (end < blob.length && bytes < chunkBytes) {
        bytes += encoder.encode(blob[end]).length;
        end += 1;
      }
      var slice = blob.slice(offset, end);
      offset = end;
      index += 1;
      var key = 'gen-' + String(index).padStart(4, '0');
      var info = await getJson('/api/kv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, value: slice })
      });
      written += info.logicalBytes;
    }
    setText('put-log', '已写入 ' + index + ' 条，逻辑 ' + fmtBytes(written));
    loadKeys(true);
    poll();
  } catch (err) {
    setText('put-log', '生成失败：' + err.message);
  }
  byId('btn-gen').disabled = false;
}

async function flush() {
  try {
    var result = await getJson('/api/flush', { method: 'POST' });
    setText('put-log', '已清空 ' + result.flushed + ' 条');
    state.history = [];
    loadKeys(true);
    poll();
  } catch (err) {
    setText('put-log', '清空失败：' + err.message);
  }
}

function init() {
  byId('btn-put').addEventListener('click', doPut);
  byId('btn-gen').addEventListener('click', generate);
  byId('btn-bench').addEventListener('click', runBench);
  byId('btn-flush').addEventListener('click', flush);
  byId('btn-more').addEventListener('click', function () { loadKeys(false); });
  window.addEventListener('resize', drawChart);
  poll();
  loadKeys(true);
  setInterval(poll, POLL_MS);
  setInterval(function () { loadKeys(true); }, 5000);
}

document.addEventListener('DOMContentLoaded', init);
