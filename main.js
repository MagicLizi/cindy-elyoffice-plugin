'use strict';
/*
 * ElyOffice 插件逻辑（浏览器沙箱）。
 * - 接 AI 工具调用，转给 node/worker.cjs 调 ElyOffice 命令行；
 * - 为设置页提供安装 / 更新 / 卸载 / 自动保存的状态与操作（经 BroadcastChannel）；
 * - 下载走 Cindy 自带的 cindy.downloads（强制校验值与大小、进度、重试、续传）。
 */

var REPO = 'ELY-Open-Source/ElyOffice';
var KV_READY = 'elyoffice_ready';
var KV_AUTOSAVE = 'autoSave';
var LATEST_TTL_MS = 6 * 60 * 60 * 1000;

var channel = new BroadcastChannel('elyoffice');
var job = { phase: 'idle' };
var detectInfo = null;
var latest = null; // { at, value }
var latestError = null;
var autoSave = false;
var activeDownloadId = null;
var cancelRequested = false;
var pollTimer = null;
var broadcastTimer = null;
var uiLang = 'en'; // 只跟随 Cindy 界面语言：zh-CN 用中文，其余用英文

var NOTICES = {
  installed: {
    'zh-CN': function (v) { return 'ElyOffice ' + (v || '') + ' 已装好，现在可以在 Cindy 里用它打开和修改文档了。'; },
    en: function (v) { return 'ElyOffice ' + (v || '') + ' is installed. You can now open and edit documents with it from Cindy.'; },
  },
  uninstalled: {
    'zh-CN': function () { return 'ElyOffice 已卸载。'; },
    en: function () { return 'ElyOffice has been uninstalled.'; },
  },
};

function notice(key, arg) {
  var set = NOTICES[key];
  return (set[uiLang] || set.en)(arg);
}

async function loadUiLang() {
  try {
    var r = await cindy.request({ kind: 'app-context' });
    var ctx = r && r.context;
    var lang = ctx && (ctx.uiLocale || ctx.locale);
    uiLang = lang === 'zh-CN' ? 'zh-CN' : 'en';
  } catch (e) {}
}

// ───────────── 基础工具 ─────────────

function cmpVersion(a, b) {
  var pa = String(a || '0').split(/[.+-]/).map(function (n) { return parseInt(n, 10) || 0; });
  var pb = String(b || '0').split(/[.+-]/).map(function (n) { return parseInt(n, 10) || 0; });
  for (var i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    var d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function bizError(errorCode, message, extra) {
  var e = new Error(message);
  e.errorCode = errorCode;
  if (extra) Object.assign(e, extra);
  return e;
}

async function nodeCall(method, params, opts) {
  opts = opts || {};
  var req = { method: method, params: params || {}, timeoutMs: opts.timeoutMs || 60000 };
  if (opts.callId) req.callId = opts.callId;
  if (opts.downloadTokens) req.downloadTokens = opts.downloadTokens;
  var r;
  try {
    r = await cindy.node.request(req);
  } catch (e) {
    return { ok: false, errorCode: 'NODE_UNAVAILABLE', message: '插件后台没有响应：' + ((e && e.message) || e) };
  }
  if (!r || !r.ok) {
    return {
      ok: false,
      errorCode: (r && r.errorCode) || 'NODE_UNAVAILABLE',
      message: (r && r.message) || '插件后台没有响应，请稍后再试。',
    };
  }
  var result = r.result;
  if (!result || typeof result !== 'object') {
    return { ok: false, errorCode: 'NODE_INVALID', message: '插件后台返回了无法识别的结果。' };
  }
  return result;
}

async function readKv() {
  try {
    var r = await fetch('/kv');
    if (!r.ok) return {};
    var j = await r.json();
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch (e) {
    return {};
  }
}

var kvChain = Promise.resolve();
function patchKv(patch) {
  kvChain = kvChain.then(async function () {
    var cur = await readKv();
    var next = Object.assign({}, cur);
    var changed = false;
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v === null || v === undefined) {
        if (Object.prototype.hasOwnProperty.call(next, k)) {
          delete next[k];
          changed = true;
        }
      } else if (next[k] !== v) {
        next[k] = v;
        changed = true;
      }
    });
    if (changed) await fetch('/kv', { method: 'PUT', body: JSON.stringify(next) });
  }).catch(function () {});
  return kvChain;
}

async function notify(text, tone) {
  try {
    await cindy.send({ type: 'notify', text: text, tone: tone || 'info' });
  } catch (e) {}
}

// ───────────── 状态与广播 ─────────────

function buildState() {
  var det = detectInfo && detectInfo.ok ? detectInfo : null;
  var lv = latest && latest.value && latest.value.ok ? latest.value : null;
  return {
    ready: Boolean(det),
    platform: det ? det.platform : null,
    installSupported: det ? det.installSupported : null,
    installed: det ? det.installed : false,
    version: det ? det.version : null,
    latest: lv ? { version: lv.version, bytes: lv.bytes, notesUrl: lv.notesUrl } : null,
    latestError: latestError,
    updateAvailable: Boolean(det && det.installed && lv && det.version && cmpVersion(lv.version, det.version) > 0),
    job: job,
    autoSave: autoSave,
  };
}

function broadcastNow() {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  }
  try {
    channel.postMessage({ type: 'state', state: buildState() });
  } catch (e) {}
}

function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(broadcastNow, 250);
}

function setJob(patch, replace) {
  job = replace ? Object.assign({}, patch) : Object.assign({}, job, patch);
  if (job.phase === 'downloading' || job.phase === 'verifying') scheduleBroadcast();
  else broadcastNow();
}

function isBusy() {
  return ['checking', 'downloading', 'verifying', 'installing', 'waiting-user', 'uninstalling'].indexOf(job.phase) !== -1;
}

// ───────────── 检测与就绪标记 ─────────────

async function refreshDetect(force) {
  var r = await nodeCall('detect', { force: Boolean(force) });
  if (r.ok) {
    detectInfo = r;
    // 插件「使用前设置」按这个键判断是否就绪：装了就写版本号，没装就清掉。
    await patchKv(r.installed ? { elyoffice_ready: r.version || 'installed' } : { elyoffice_ready: null });
  }
  return r;
}

// ───────────── 最新版本（经 Cindy 网络通道取，后台核对签名） ─────────────

async function hostText(url, accept) {
  var req = { url: url, method: 'GET', timeoutMs: 30000 };
  if (accept) req.headers = { Accept: accept };
  var r = await cindy.fetch(req);
  if (!r || !r.ok) throw bizError('NETWORK_FAILED', '连不上 GitHub：' + ((r && r.message) || '网络错误') + '。请检查网络后再试。');
  if (r.status !== 200) throw bizError('NETWORK_FAILED', 'GitHub 暂时不可用（' + r.status + '），请稍后再试。');
  if (r.truncated) throw bizError('NETWORK_FAILED', 'GitHub 返回的内容不完整，请稍后再试。');
  return String(r.body || '');
}

async function assetSize(v) {
  var body = await hostText('https://api.github.com/repos/' + REPO + '/releases/tags/v' + encodeURIComponent(v.version), 'application/vnd.github+json');
  var data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw bizError('NETWORK_FAILED', 'GitHub 返回的发布信息看不懂，请稍后再试。');
  }
  var asset = (data.assets || []).find(function (a) { return a && a.name === v.assetName; });
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw bizError('MANIFEST_INVALID', '没有在 ElyOffice 发布页找到安装包的大小信息。');
  }
  if (typeof asset.digest === 'string' && asset.digest.indexOf('sha256:') === 0 && asset.digest.slice(7) !== v.sha256) {
    throw bizError('CHECKSUM_MISMATCH', 'GitHub 上的安装包和 ElyOffice 官方签名清单对不上，已停止。');
  }
  return asset.size;
}

async function checkLatest(force) {
  if (!force && latest && Date.now() - latest.at < LATEST_TTL_MS) return latest.value;
  var det = detectInfo && detectInfo.ok ? detectInfo : await refreshDetect(false);
  if (!det.ok) return det;
  if (!det.platformKey) {
    latestError = '这台电脑的系统没有对应的 ElyOffice 版本。';
    return { ok: false, errorCode: 'UNSUPPORTED_PLATFORM', message: latestError };
  }
  try {
    var name = 'ely-office-' + det.platformKey + '.json';
    var base = 'https://github.com/' + REPO + '/releases/latest/download/';
    var texts = await Promise.all([hostText(base + name), hostText(base + name + '.sig')]);
    var v = await nodeCall('release/verify', { name: name, manifest: texts[0], signature: texts[1], platformKey: det.platformKey });
    if (!v.ok) throw bizError(v.errorCode, v.message);
    var bytes = await assetSize(v);
    var value = {
      ok: true,
      version: v.version,
      url: v.url,
      sha256: v.sha256,
      assetName: v.assetName,
      bytes: bytes,
      notesUrl: 'https://github.com/' + REPO + '/releases/tag/v' + v.version,
    };
    latest = { at: Date.now(), value: value };
    latestError = null;
    return value;
  } catch (e) {
    latestError = e.message || String(e);
    return { ok: false, errorCode: e.errorCode || 'NETWORK_FAILED', message: latestError };
  }
}

// ───────────── 安装 / 更新 / 卸载 ─────────────

function failJob(e) {
  setJob({
    phase: 'error',
    errorCode: e.errorCode || 'INTERNAL',
    message: e.message || String(e),
    detail: e.detail || null,
    reason: e.reason || null,
    running: e.running || null,
    version: job.version || null,
  }, true);
}

function fromResult(r) {
  return bizError(r.errorCode, r.message, r.detail ? { detail: r.detail } : null);
}

async function runInstall() {
  if (isBusy()) return;
  cancelRequested = false;
  setJob({ phase: 'checking' }, true);
  try {
    var det = await refreshDetect(true);
    if (!det.ok) throw fromResult(det);
    if (!det.installSupported) {
      throw bizError('UNSUPPORTED_PLATFORM', '这台电脑暂不支持一键安装，请到 ElyOffice 发布页按说明安装。');
    }
    if (det.installed) {
      var running = await nodeCall('apps/running');
      if (running.ok && running.running.length) {
        throw bizError('APPS_RUNNING', '更新前要先关闭 ElyOffice。', { running: running.running });
      }
    }
    var rel = await checkLatest(true);
    if (!rel.ok) throw fromResult(rel);
    if (det.installed && det.version && cmpVersion(det.version, rel.version) >= 0) {
      setJob({ phase: 'idle' }, true);
      return;
    }
    var disk = await nodeCall('disk/check', { bytes: rel.bytes });
    if (!disk.ok) throw fromResult(disk);

    var id = ('elyoffice-' + rel.version + '-' + det.platformKey).replace(/[^\w-]/g, '-');
    activeDownloadId = id;
    setJob({ phase: 'downloading', version: rel.version, loaded: 0, total: rel.bytes, speedBps: 0 }, true);
    var d = await cindy.downloads.start({ id: id, url: rel.url, sha256: rel.sha256, bytes: rel.bytes });
    activeDownloadId = null;
    if (cancelRequested) {
      setJob({ phase: 'idle' }, true);
      return;
    }
    if (!d || !d.ok) {
      throw bizError(
        'DOWNLOAD_FAILED',
        '下载没完成，网络好像不太稳定。已经下载的部分会保留，点「继续下载」会接着下。',
      );
    }
    setJob({ phase: 'installing', version: rel.version, startedAt: Date.now() }, true);
    var started = await nodeCall(
      'install/start',
      { version: rel.version, sha256: rel.sha256, assetName: rel.assetName },
      { downloadTokens: { installer: d.token }, timeoutMs: 120000 },
    );
    if (!started.ok) throw fromResult(started);
    if (started.phase === 'waiting-user') setJob({ phase: 'waiting-user' });
    startPolling();
  } catch (e) {
    activeDownloadId = null;
    failJob(e);
  }
}

async function cancelJob() {
  if (job.phase === 'downloading' || job.phase === 'verifying' || job.phase === 'checking') {
    cancelRequested = true;
    if (activeDownloadId) {
      try {
        await cindy.downloads.cancel({ id: activeDownloadId });
      } catch (e) {}
    }
    setJob({ phase: 'idle' }, true);
  } else if (job.phase === 'waiting-user') {
    await nodeCall('install/cancel-wait');
    stopPolling();
    setJob({ phase: 'idle' }, true);
  }
}

async function runUninstall() {
  if (isBusy()) return;
  setJob({ phase: 'uninstalling' }, true);
  var r = await nodeCall('uninstall/start');
  if (!r.ok) {
    failJob(fromResult(r));
    return;
  }
  if (r.alreadyRemoved) {
    await refreshDetect(true);
    setJob({ phase: 'done', kind: 'uninstall' }, true);
    return;
  }
  startPolling();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollJob, 2000);
  pollJob();
}

var polling = false;
async function pollJob() {
  if (polling) return;
  polling = true;
  try {
    var s = await nodeCall('job/status');
    if (!s.ok) return;
    if (s.phase === 'installing' || s.phase === 'waiting-user' || s.phase === 'uninstalling') {
      if (job.phase !== s.phase) setJob({ phase: s.phase, version: s.version || job.version || null });
      return;
    }
    stopPolling();
    if (s.phase === 'done') {
      await refreshDetect(true);
      if (s.kind === 'uninstall') {
        setJob({ phase: 'done', kind: 'uninstall' }, true);
        notify(notice('uninstalled'), 'info');
      } else {
        setJob({ phase: 'done', kind: 'install', version: s.version }, true);
        notify(notice('installed', s.version), 'success');
      }
    } else if (s.phase === 'failed') {
      await refreshDetect(true);
      var msg;
      var reason = 'generic';
      if (s.kind === 'uninstall') {
        msg = '卸载没有完成。请关闭所有 ElyOffice 窗口后再试，或在 Windows「设置 → 应用」里卸载。';
      } else if (s.reason === 'timeout') {
        reason = 'timeout';
        msg = '等了很久也没有看到 ElyOffice 装好。如果系统安装器还开着，请完成安装后点「重试」。';
      } else if (s.exitCode === 2) {
        reason = 'busy';
        msg = '安装没有完成：ElyOffice 的部分文件正被占用。请关闭所有 ElyOffice 窗口后点「重试」。';
      } else {
        msg = '安装没有完成。请点「重试」；如果还是不行，可以到 ElyOffice 发布页手动下载安装。';
      }
      failJob(bizError(s.kind === 'uninstall' ? 'UNINSTALL_FAILED' : 'INSTALL_FAILED', msg, { reason: reason }));
    } else {
      setJob({ phase: 'idle' }, true);
    }
  } finally {
    polling = false;
  }
}

async function recoverJob() {
  if (isBusy() || pollTimer) return;
  var s = await nodeCall('job/status');
  if (s.ok && (s.phase === 'installing' || s.phase === 'waiting-user' || s.phase === 'uninstalling')) {
    setJob({ phase: s.phase, version: s.version || null }, true);
    startPolling();
  }
}

// ───────────── 设置页通道 ─────────────

async function handleAction(action, args) {
  if (action === 'state') {
    await refreshDetect(true);
    await recoverJob();
    var kv = await readKv();
    autoSave = kv[KV_AUTOSAVE] === true;
    if (!latest) {
      checkLatest(false).then(broadcastNow);
    }
    return buildState();
  }
  if (action === 'check-update') {
    await checkLatest(true);
    return buildState();
  }
  if (action === 'install') {
    if (job.phase === 'error' || job.phase === 'done') setJob({ phase: 'idle' }, true);
    runInstall();
    return buildState();
  }
  if (action === 'cancel') {
    await cancelJob();
    return buildState();
  }
  if (action === 'uninstall') {
    if (job.phase === 'error' || job.phase === 'done') setJob({ phase: 'idle' }, true);
    runUninstall();
    return buildState();
  }
  if (action === 'dismiss') {
    if (!isBusy()) setJob({ phase: 'idle' }, true);
    return buildState();
  }
  if (action === 'set-auto-save') {
    autoSave = Boolean(args && args.value);
    await patchKv({ autoSave: autoSave });
    broadcastNow();
    return buildState();
  }
  return { error: '未知操作' };
}

// 设置页会反复重发同一请求直到收到回执，这里按请求编号去重，保证每个操作只执行一次。
var handled = new Map();
function rememberRequest(id, promise) {
  handled.set(id, { at: Date.now(), promise: promise });
  if (handled.size > 200) {
    var cutoff = Date.now() - 2 * 60 * 1000;
    handled.forEach(function (v, k) { if (v.at < cutoff) handled.delete(k); });
  }
}

channel.onmessage = async function (ev) {
  var msg = ev && ev.data;
  if (!msg || msg.type !== 'req' || typeof msg.id !== 'string') return;
  var entry = handled.get(msg.id);
  var promise = entry ? entry.promise : (async function () {
    try {
      return await handleAction(msg.action, msg.args || {});
    } catch (e) {
      return Object.assign(buildState(), { actionError: (e && e.message) || String(e) });
    }
  })();
  if (!entry) rememberRequest(msg.id, promise);
  var data = await promise;
  try {
    channel.postMessage({ type: 'res', id: msg.id, data: data });
  } catch (e) {}
};

// ───────────── AI 工具 ─────────────

var TOOL_METHODS = {
  elyoffice_status: 'status',
  open_document: 'doc/open',
  read_document: 'doc/read',
  replace_text: 'doc/replace',
  read_cells: 'cells/read',
  write_cells: 'cells/write',
  save_document: 'doc/save',
};

function toolParams(tool, args) {
  var a = args || {};
  if (tool === 'elyoffice_status') return {};
  if (tool === 'replace_text') return { path: a.path, replacements: a.replacements };
  if (tool === 'read_cells') return { path: a.path, addresses: a.addresses };
  if (tool === 'write_cells') return { path: a.path, cells: a.cells };
  return { path: a.path };
}

async function sendResult(callId, r) {
  if (!r.ok) {
    await cindy.send({ type: 'tool-result', callId: callId, ok: false, errorCode: r.errorCode || 'FAILED', message: r.message || '操作失败' });
    return;
  }
  var result = Object.assign({}, r);
  delete result.ok;
  await cindy.send({ type: 'tool-result', callId: callId, ok: true, result: result });
}

async function handleToolCall(msg) {
  var method = TOOL_METHODS[msg.tool];
  if (!method) {
    await sendResult(msg.callId, { ok: false, errorCode: 'UNKNOWN_TOOL', message: '没有这个工具：' + msg.tool });
    return;
  }
  var r = await nodeCall(method, toolParams(msg.tool, msg.args), { callId: msg.callId, timeoutMs: 120000 });
  if (!r.ok) {
    if (r.errorCode === 'ELYOFFICE_NOT_INSTALLED') await refreshDetect(true);
    await sendResult(msg.callId, r);
    return;
  }
  if (msg.tool === 'elyoffice_status') {
    var lv = latest && latest.value && latest.value.ok ? latest.value : null;
    if (lv && r.version && cmpVersion(lv.version, r.version) > 0) r.updateAvailable = lv.version;
    if (!r.installed) r.hint = '还没有安装 ElyOffice：请用户打开「插件 → ElyOffice」设置页一键安装。';
  }
  var modified = (msg.tool === 'replace_text' && r.totalReplaced > 0) || msg.tool === 'write_cells';
  if (modified) {
    var kv = await readKv();
    if (kv[KV_AUTOSAVE] === true) {
      var s = await nodeCall('doc/save', { path: r.path }, { callId: msg.callId });
      r.saved = Boolean(s.ok);
      if (s.ok) r.savedTo = s.savedTo;
      else r.saveError = s.message;
    } else {
      r.saved = false;
      r.saveHint = '改动已显示在 ElyOffice 窗口里，但还没有保存：请告诉用户检查后按 Ctrl+S（macOS 为 Cmd+S）保存，或在用户要求时调用 save_document。';
    }
  }
  await sendResult(msg.callId, r);
}

function onDownloadProgress(d) {
  if (!d || !activeDownloadId || d.id !== activeDownloadId) return;
  if (job.phase !== 'downloading' && job.phase !== 'verifying') return;
  var patch = {
    loaded: typeof d.loaded === 'number' ? d.loaded : job.loaded,
    total: typeof d.total === 'number' && d.total > 0 ? d.total : job.total,
    speedBps: typeof d.speedBps === 'number' ? d.speedBps : 0,
    attempt: d.phase === 'retrying' ? d.attempt || null : null,
    retrying: d.phase === 'retrying',
  };
  if (d.phase === 'verifying') patch.phase = 'verifying';
  else if (d.phase === 'downloading' || d.phase === 'queued' || d.phase === 'retrying') patch.phase = 'downloading';
  setJob(patch);
}

cindy.onHostMessage(function (msg) {
  if (!msg) return;
  if (msg.type === 'host-context-changed') {
    var ctx = msg.context || {};
    var lang = ctx.uiLocale || ctx.locale;
    uiLang = lang === 'zh-CN' ? 'zh-CN' : 'en';
    try {
      channel.postMessage({ type: 'locale' });
    } catch (e) {}
    return;
  }
  if (msg.type === 'event' && msg.name === 'download-progress') {
    onDownloadProgress(msg.data);
    return;
  }
  if (msg.type === 'tool-call') {
    handleToolCall(msg).catch(function (e) {
      sendResult(msg.callId, { ok: false, errorCode: 'INTERNAL', message: '插件出错：' + ((e && e.message) || e) });
    });
  }
});

// 启动时同步一次：电脑上已有 ElyOffice 的用户无需再点安装；并接上进行中的安装。
readKv().then(function (kv) {
  autoSave = kv[KV_AUTOSAVE] === true;
});
loadUiLang();
refreshDetect(false).then(function () {
  return recoverJob();
}).catch(function () {});
