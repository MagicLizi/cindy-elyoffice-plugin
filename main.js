'use strict';
/*
 * ElyOffice 插件逻辑（浏览器沙箱）。
 * - 接 AI 工具调用，转给 node/worker.cjs 调 ElyOffice 命令行；
 * - 为设置页提供安装 / 更新 / 卸载 / 自动保存的状态与操作（经 BroadcastChannel）；
 * - 下载走 Cindy 自带的 cindy.downloads（强制校验 SHA-256，带进度、重试、续传）。
 */

var REPO = 'ELY-Open-Source/ElyOffice';
var KV_READY = 'elyoffice_ready';
var KV_AUTOSAVE = 'autoSave';
var KV_LATEST = 'latestRelease';
var KV_LATEST_FAILURE = 'latestReleaseFailure';
var LATEST_TTL_MS = 6 * 60 * 60 * 1000;
var LATEST_RETRY_MS = 10 * 60 * 1000;
// 安装包大小未知时，按这个量预估下载所需的磁盘空间（当前安装包 240–370 MB）。
var UNKNOWN_INSTALLER_BYTES = 512 * 1024 * 1024;
// 旧版 Cindy 拒绝不带大小的下载时回的原话（Cindy 0.1.144 起不变）。
var LEGACY_SIZE_REQUIRED = 'URL, SHA-256 and exact size (up to 8 GiB) are required';
// 自动下载失败时给用户的手动下载入口：优先这台电脑的安装包直链（来自验过签的清单），否则发布页。
var RELEASES_PAGE_URL = 'https://github.com/' + REPO + '/releases/latest';
// 这几类失败换手动下载能解决；签名、校验值对不上这类安全问题不引导用户手动安装。
var MANUAL_DOWNLOAD_ERRORS = { NETWORK_FAILED: true, GITHUB_RATE_LIMITED: true, DOWNLOAD_FAILED: true };

var channel = new BroadcastChannel('elyoffice');
var job = { phase: 'idle' };
var detectInfo = null;
var latest = null; // { at, value }：最近一次查到并核对过签名的版本
var latestFailure = null; // { at, value }：最近一次查询失败
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

function manualDownload() {
  var det = detectInfo && detectInfo.ok ? detectInfo : null;
  var lv = latest && latest.value && latest.value.ok ? latest.value : null;
  // 清单里的地址已由后台核对过签名和前缀（只会是 ElyOffice 官方发布页的下载地址）。
  if (det && lv && lv.platformKey === det.platformKey && typeof lv.url === 'string' &&
      lv.url.indexOf(RELEASE_DOWNLOAD_PREFIX) === 0) {
    return { url: lv.url, direct: true, version: lv.version };
  }
  return { url: RELEASES_PAGE_URL, direct: false, version: null };
}

function buildState() {
  var det = detectInfo && detectInfo.ok ? detectInfo : null;
  var lv = latest && latest.value && latest.value.ok ? latest.value : null;
  var failure = currentLatestFailure();
  return {
    ready: Boolean(det),
    platform: det ? det.platform : null,
    installSupported: det ? det.installSupported : null,
    installed: det ? det.installed : false,
    version: det ? det.version : null,
    latest: lv ? { version: lv.version, bytes: lv.bytes || null, notesUrl: lv.notesUrl } : null,
    latestError: failure ? failure.message : null,
    latestErrorCode: failure ? failure.errorCode : null,
    updateAvailable: Boolean(det && det.installed && lv && det.version && cmpVersion(lv.version, det.version) > 0),
    manualDownload: manualDownload(),
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
//
// 查版本不调用 api.github.com：GitHub 对未登录的 API 查询按网络出口每小时只给 60 次，
// VPN、代理或多人共用的出口很容易被别人用完。版本清单和签名直接从发布页的下载地址取，
// 不占这个额度；签名照旧用 ElyOffice 官方公钥核对。只有旧版 Cindy 下载前必须知道
// 安装包的准确大小，那时才查一次 API（见 installerSizeFromApi）。

var RELEASE_DOWNLOAD_PREFIX = 'https://github.com/' + REPO + '/releases/download/';
var RATE_LIMIT_MESSAGE = 'GitHub 暂时限制了你当前网络的查询次数（使用 VPN／代理或多人共用网络时常见），通常一小时内恢复；换个网络可以马上重试。';

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isRateLimited(status, body) {
  return status === 429 || (status === 403 && /rate limit/i.test(String(body || '')));
}

function httpError(status, body) {
  if (isRateLimited(status, body)) return bizError('GITHUB_RATE_LIMITED', RATE_LIMIT_MESSAGE);
  return bizError('NETWORK_FAILED', 'GitHub 暂时不可用（' + status + '），请稍后再试。');
}

// 清单和签名在发布页上标成二进制类型，文本方式取不回；按媒体方式取时，
// Cindy 会把其中的 UTF-8 文本照样按文本交回。返回 null 表示发布页上没有这个文件。
async function fetchReleaseText(url) {
  for (var attempt = 0; ; attempt += 1) {
    var r;
    try {
      r = await cindy.fetch({ url: url, method: 'GET', as: 'media', timeoutMs: 30000 });
    } catch (e) {
      r = { ok: false, message: (e && e.message) || String(e) };
    }
    if (r && r.ok) {
      if (r.status === 404) return null;
      if (r.status !== 200) throw httpError(r.status, r.body);
      if (r.media || typeof r.body !== 'string' || r.truncated) {
        throw bizError('MANIFEST_INVALID', 'ElyOffice 发布页上的版本清单不是预期的内容，已停止。');
      }
      return r.body;
    }
    var message = (r && r.message) || '网络错误';
    // Cindy 的大文件通道同一时间只处理一单，正忙时稍等再取。
    if (/正忙|busy/i.test(message) && attempt < 3) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    throw bizError('NETWORK_FAILED', '连不上 GitHub：' + message + '。请检查网络后再试。');
  }
}

// 只用来拼签名地址；真正的版本号以验签后的清单为准。
function unverifiedManifestVersion(text) {
  try {
    var v = JSON.parse(text).version;
    return typeof v === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/.test(v) ? v : null;
  } catch (e) {
    return null;
  }
}

async function fetchSignedRelease(platformKey) {
  var name = 'ely-office-' + platformKey + '.json';
  var manifest = await fetchReleaseText('https://github.com/' + REPO + '/releases/latest/download/' + name);
  if (manifest === null) throw bizError('UNSUPPORTED_PLATFORM', '最新版本没有提供这台电脑可用的安装包。');
  var version = unverifiedManifestVersion(manifest);
  if (!version) throw bizError('MANIFEST_INVALID', 'ElyOffice 发布页上的版本清单格式不对，已停止。');
  // 签名按清单里的版本固定到同一个发布，两次请求之间正好发了新版也不会拿到不配对的签名。
  var signature = await fetchReleaseText(RELEASE_DOWNLOAD_PREFIX + 'v' + encodeURIComponent(version) + '/' + name + '.sig');
  if (signature === null) throw bizError('MANIFEST_INVALID', 'ElyOffice 发布页上缺少版本清单的签名，已停止。');
  var v = await nodeCall('release/verify', { name: name, manifest: manifest, signature: signature, platformKey: platformKey });
  if (!v.ok) throw bizError(v.errorCode, v.message);
  if (v.version !== version) throw bizError('MANIFEST_INVALID', 'ElyOffice 发布页上的版本信息前后不一致，已停止。');
  return {
    ok: true,
    platformKey: platformKey,
    version: v.version,
    url: v.url,
    sha256: v.sha256,
    assetName: v.assetName,
    bytes: null,
    notesUrl: 'https://github.com/' + REPO + '/releases/tag/v' + v.version,
  };
}

// 旧版 Cindy 的下载必须事先给出准确大小，签名清单里没有，只能查一次 API。
async function installerSizeFromApi(rel) {
  var r;
  try {
    r = await cindy.fetch({
      url: 'https://api.github.com/repos/' + REPO + '/releases/tags/v' + encodeURIComponent(rel.version),
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      timeoutMs: 30000,
    });
  } catch (e) {
    r = { ok: false, message: (e && e.message) || String(e) };
  }
  if (!r || !r.ok) throw bizError('NETWORK_FAILED', '连不上 GitHub：' + ((r && r.message) || '网络错误') + '。请检查网络后再试。');
  if (r.status !== 200) throw httpError(r.status, r.body);
  if (r.truncated) throw bizError('NETWORK_FAILED', 'GitHub 返回的内容不完整，请稍后再试。');
  var release;
  try {
    release = JSON.parse(String(r.body || ''));
  } catch (e) {
    throw bizError('NETWORK_FAILED', 'GitHub 返回的发布信息看不懂，请稍后再试。');
  }
  var installer = ((release && release.assets) || []).find(function (a) { return a && a.name === rel.assetName; });
  if (!installer || !Number.isSafeInteger(installer.size) || installer.size <= 0) {
    throw bizError('MANIFEST_INVALID', '没有在 ElyOffice 发布页找到安装包的大小信息。');
  }
  var digest = typeof installer.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(installer.digest)
    ? installer.digest.slice(7)
    : null;
  if (digest && digest !== rel.sha256) {
    throw bizError('CHECKSUM_MISMATCH', 'GitHub 上的安装包和 ElyOffice 官方签名清单对不上，已停止。');
  }
  return installer.size;
}

// 新版 Cindy 只凭 SHA-256 就能下载，大小从下载响应里读；旧版会明确拒绝，再补查大小重下。
async function downloadInstaller(rel, id) {
  var req = { id: id, url: rel.url, sha256: rel.sha256 };
  if (rel.bytes) req.bytes = rel.bytes;
  var d = await cindy.downloads.start(req);
  if (rel.bytes || !d || d.ok !== false || d.message !== LEGACY_SIZE_REQUIRED || cancelRequested) return d;
  rel.bytes = await installerSizeFromApi(rel);
  if (latest && latest.value === rel) saveLatest();
  if (cancelRequested) return { ok: false, message: '下载已取消' };
  setJob({ total: rel.bytes });
  return cindy.downloads.start({ id: id, url: rel.url, sha256: rel.sha256, bytes: rel.bytes });
}

// ── 查到的结果存进插件存储：插件重启也不用重新查；失败后一段时间内不反复请求 ──

function validCachedRelease(s) {
  var v = s && s.value;
  return Boolean(
    s && typeof s.at === 'number' && v && v.ok === true &&
    typeof v.platformKey === 'string' && typeof v.version === 'string' &&
    typeof v.url === 'string' && v.url.indexOf(RELEASE_DOWNLOAD_PREFIX) === 0 &&
    typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256) &&
    typeof v.assetName === 'string' && /^[\w.-]+$/.test(v.assetName) &&
    (v.bytes === null || (Number.isSafeInteger(v.bytes) && v.bytes > 0)),
  );
}

function validCachedFailure(f) {
  return Boolean(
    f && typeof f.at === 'number' && typeof f.platformKey === 'string' &&
    typeof f.errorCode === 'string' && typeof f.message === 'string',
  );
}

var latestCacheLoaded = null;
function loadLatestCache() {
  if (!latestCacheLoaded) {
    latestCacheLoaded = readKv().then(function (kv) {
      var s = kv[KV_LATEST];
      if (!latest && validCachedRelease(s)) {
        latest = { at: s.at, value: Object.assign({ notesUrl: 'https://github.com/' + REPO + '/releases/tag/v' + s.value.version }, s.value) };
      }
      var f = kv[KV_LATEST_FAILURE];
      if (!latestFailure && validCachedFailure(f)) {
        latestFailure = { at: f.at, value: { ok: false, platformKey: f.platformKey, errorCode: f.errorCode, message: f.message } };
      }
    }).catch(function () {});
  }
  return latestCacheLoaded;
}

function saveLatest() {
  var v = latest.value;
  var stored = {
    at: latest.at,
    value: {
      ok: true, platformKey: v.platformKey, version: v.version, url: v.url,
      sha256: v.sha256, assetName: v.assetName, bytes: v.bytes || null,
    },
  };
  var patch = {};
  patch[KV_LATEST] = stored;
  patch[KV_LATEST_FAILURE] = null;
  return patchKv(patch);
}

function saveLatestFailure() {
  var f = latestFailure;
  var patch = {};
  patch[KV_LATEST_FAILURE] = { at: f.at, platformKey: f.value.platformKey, errorCode: f.value.errorCode, message: f.value.message };
  return patchKv(patch);
}

function fresh(entry, platformKey, ttl) {
  var age = Date.now() - (entry ? entry.at : 0);
  return Boolean(entry && entry.value.platformKey === platformKey && age >= 0 && age < ttl);
}

// 上次成功之后又失败过时，才把失败显示出来。
function currentLatestFailure() {
  return latestFailure && (!latest || latestFailure.at > latest.at) ? latestFailure.value : null;
}

// force：用户点了「检查更新／安装／重试」，一定重新查；其余调用优先用存下的结果。
var latestInflight = null;
async function checkLatest(force) {
  await loadLatestCache();
  var det = detectInfo && detectInfo.ok ? detectInfo : await refreshDetect(false);
  if (!det.ok) return det;
  if (!det.platformKey) {
    return { ok: false, errorCode: 'UNSUPPORTED_PLATFORM', message: '这台电脑的系统没有对应的 ElyOffice 版本。' };
  }
  var key = det.platformKey;
  if (!force) {
    if (fresh(latest, key, LATEST_TTL_MS)) return latest.value;
    if (fresh(latestFailure, key, LATEST_RETRY_MS)) return latestFailure.value;
  }
  if (!latestInflight) {
    latestInflight = fetchSignedRelease(key).then(function (value) {
      latest = { at: Date.now(), value: value };
      latestFailure = null;
      saveLatest();
      return value;
    }, function (e) {
      latestFailure = {
        at: Date.now(),
        value: { ok: false, platformKey: key, errorCode: e.errorCode || 'NETWORK_FAILED', message: e.message || String(e) },
      };
      saveLatestFailure();
      return latestFailure.value;
    }).finally(function () {
      latestInflight = null;
    });
  }
  return latestInflight;
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
    var disk = await nodeCall('disk/check', { bytes: rel.bytes || UNKNOWN_INSTALLER_BYTES });
    if (!disk.ok) throw fromResult(disk);

    var id = ('elyoffice-' + rel.version + '-' + det.platformKey).replace(/[^\w-]/g, '-');
    activeDownloadId = id;
    setJob({ phase: 'downloading', version: rel.version, loaded: 0, total: rel.bytes || null, speedBps: 0 }, true);
    var d = await downloadInstaller(rel, id);
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
    var det = await refreshDetect(true);
    await recoverJob();
    // 自动下载失败后用户自己下载安装好了（版本不旧于已知最新版）：上次的失败已经没意义，收起错误。
    var known = latest && latest.value && latest.value.ok ? latest.value : null;
    if (job.phase === 'error' && MANUAL_DOWNLOAD_ERRORS[job.errorCode] && det.ok && det.installed &&
        (!known || (det.version && cmpVersion(det.version, known.version) >= 0))) {
      setJob({ phase: 'idle' }, true);
    }
    var kv = await readKv();
    autoSave = kv[KV_AUTOSAVE] === true;
    // 有存下的结果就直接用，查询失败后 10 分钟内也不再请求，用户点「检查更新」才强制重查。
    checkLatest(false).then(broadcastNow);
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
  create_document: 'doc/create',
  read_document: 'doc/read',
  replace_text: 'doc/replace',
  read_cells: 'cells/read',
  write_cells: 'cells/write',
  write_table: 'cells/write-table',
  save_document: 'doc/save',
};

function toolParams(tool, args) {
  var a = args || {};
  if (tool === 'elyoffice_status') return {};
  if (tool === 'open_document') return { path: a.path, newWindow: a.newWindow === true };
  if (tool === 'create_document') {
    return {
      path: a.path,
      from: a.from,
      sheets: a.sheets,
      paragraphs: a.paragraphs,
      slides: a.slides,
      text: a.text,
      open: a.open,
      newWindow: a.newWindow === true,
    };
  }
  if (tool === 'replace_text') return { path: a.path, replacements: a.replacements };
  if (tool === 'read_cells') return { path: a.path, addresses: a.addresses };
  if (tool === 'write_cells') return { path: a.path, cells: a.cells };
  if (tool === 'write_table') return { path: a.path, start: a.start, rows: a.rows };
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
  // 120 秒是插件后台单次请求的上限：等 ElyOffice 打开最多 60 秒，500 格写入约 20 秒。
  var r = await nodeCall(method, toolParams(msg.tool, msg.args), { callId: msg.callId, timeoutMs: 120000 });
  if (!r.ok) {
    if (r.errorCode === 'ELYOFFICE_NOT_INSTALLED') await refreshDetect(true);
    await sendResult(msg.callId, r);
    return;
  }
  if (msg.tool === 'elyoffice_status') {
    var lv = await checkLatest(false);
    if (lv.ok) {
      r.latestVersion = lv.version;
      if (r.version && cmpVersion(lv.version, r.version) > 0) r.updateAvailable = lv.version;
    } else {
      r.latestVersionError = lv.message;
    }
    if (!r.installed) r.hint = '还没有安装 ElyOffice：请用户打开「插件 → ElyOffice」设置页一键安装。';
  }
  var modified = (msg.tool === 'replace_text' && r.totalReplaced > 0) || msg.tool === 'write_cells' ||
    (msg.tool === 'write_table' && r.written > 0);
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

// 用户在 Cindy 里用默认应用打开 Office 文件时(需支持 fileOpener 的 Cindy),交给 ElyOffice。
// 拉起成功回 ok:true;没装 ElyOffice 等情况回 ok:false,Cindy 改用系统默认应用。
async function handleOpenFile(msg) {
  var ok = false;
  try {
    var r = await nodeCall('doc/launch', { path: msg.data && msg.data.path }, { timeoutMs: 10000 });
    ok = Boolean(r.ok);
    if (!r.ok && r.errorCode === 'ELYOFFICE_NOT_INSTALLED') await refreshDetect(true);
  } catch (e) {
    ok = false;
  }
  try {
    await cindy.send({ type: 'file-open-result', requestId: msg.requestId, ok: ok });
  } catch (e) {}
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
  if (msg.type === 'event' && msg.name === 'open-file') {
    handleOpenFile(msg);
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
loadLatestCache();
loadUiLang();
refreshDetect(false).then(function () {
  return recoverJob();
}).catch(function () {});
