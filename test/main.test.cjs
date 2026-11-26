'use strict';
// 依据：GitHub 对未登录的 API 查询按网络出口每小时只给 60 次，VPN／代理用户常被别人用完，
// 插件因此提示「连不上 GitHub」。这里用假的 Cindy 宿主加载真实的 main.js 与 worker 验签，
// 钉住：查版本只走发布页下载地址、失败不反复请求、限流如实说明、旧版 Cindy 才补查一次 API。
process.env.ELYOFFICE_WORKER_TEST = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { METHODS } = require('../node/worker.cjs');

const NAME = 'ely-office-windows-x86_64.json';
const MANIFEST = fs.readFileSync(path.join(__dirname, 'fixtures', NAME), 'utf8');
const SIGNATURE = fs.readFileSync(path.join(__dirname, 'fixtures', `${NAME}.sig`), 'utf8');
const RELEASES = 'https://github.com/ELY-Open-Source/ElyOffice/releases/';
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const LEGACY = 'URL, SHA-256 and exact size (up to 8 GiB) are required';

// fetchRoutes(url, req) 返回 cindy.fetch 的结果；downloads(req) 返回 cindy.downloads.start 的结果。
function loadPlugin({ fetchRoutes, downloads }) {
  const requests = [];
  const installed = { value: false, version: null };
  const starts = [];
  let kv = {};
  const host = {
    fetch: async (req) => {
      requests.push(req);
      return fetchRoutes(req.url, req);
    },
    downloads: {
      start: async (req) => {
        starts.push(req);
        return downloads(req);
      },
      cancel: async () => ({ ok: true }),
    },
    node: {
      request: async ({ method, params }) => {
        if (method === 'detect') {
          return { ok: true, result: { ok: true, platform: 'win32', platformKey: 'windows-x86_64', installSupported: true, installed: installed.value, version: installed.version } };
        }
        if (method === 'job/status') return { ok: true, result: { ok: true, phase: 'idle' } };
        try {
          return { ok: true, result: { ok: true, ...(await METHODS[method](params)) } };
        } catch (e) {
          return { ok: true, result: { ok: false, errorCode: e.errorCode, message: e.message } };
        }
      },
    },
    request: async () => ({ context: { uiLocale: 'zh-CN' } }),
    send: async () => {},
    onHostMessage: () => {},
  };
  const context = vm.createContext({
    cindy: host,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    BroadcastChannel: class { postMessage() {} },
    fetch: async (url, init) => {
      if (init && init.method === 'PUT') kv = JSON.parse(init.body);
      return { ok: true, json: async () => JSON.parse(JSON.stringify(kv)) };
    },
  });
  vm.runInContext(MAIN, context, { filename: 'main.js' });
  return { context, requests, starts, installed, kv: () => kv };
}

function releaseFiles(url, req) {
  assert.equal(req.as, 'media', 'release files are binary-typed and must be fetched in media mode');
  if (url === `${RELEASES}latest/download/${NAME}`) return { ok: true, status: 200, body: MANIFEST };
  if (url === `${RELEASES}download/v0.1.17/${NAME}.sig`) return { ok: true, status: 200, body: SIGNATURE };
  throw new Error(`unexpected request ${url}`);
}

test('finds the latest signed version from the release page without the GitHub API', async () => {
  const plugin = loadPlugin({ fetchRoutes: releaseFiles, downloads: () => assert.fail('no download expected') });
  const rel = await plugin.context.checkLatest(true);
  assert.equal(rel.ok, true);
  assert.equal(rel.version, '0.1.17');
  assert.equal(rel.sha256, 'c2da2d2d2e24bc4f4609e9b06864a020cb163af519cf7c62eb1d17df6fa62bbd');
  assert.equal(rel.bytes, null);
  assert.deepEqual(plugin.requests.map((r) => r.url), [
    `${RELEASES}latest/download/${NAME}`,
    `${RELEASES}download/v0.1.17/${NAME}.sig`,
  ]);
  // 结果存进插件存储，下次（包括插件重启后）不用再查。
  await plugin.context.patchKv({});
  assert.equal(plugin.kv().latestRelease.value.version, '0.1.17');
  await plugin.context.checkLatest(false);
  assert.equal(plugin.requests.length, 2);
});

test('names GitHub rate limiting and does not ask again for a while', async () => {
  const plugin = loadPlugin({
    fetchRoutes: () => ({ ok: true, status: 429, body: 'Too many requests' }),
    downloads: () => assert.fail('no download expected'),
  });
  const first = await plugin.context.checkLatest(false);
  assert.equal(first.errorCode, 'GITHUB_RATE_LIMITED');
  assert.match(first.message, /VPN/);
  // 设置页、AI 查状态等非强制调用在 10 分钟内直接用上次结果；用户点重试才重查。
  await plugin.context.checkLatest(false);
  assert.equal(plugin.requests.length, 1);
  await plugin.context.checkLatest(true);
  assert.equal(plugin.requests.length, 2);
  assert.equal(plugin.context.buildState().latestErrorCode, 'GITHUB_RATE_LIMITED');
});

test('downloads by SHA-256 alone and asks the API for the size only on an older Cindy', async () => {
  const sizes = { ok: true, status: 200, body: JSON.stringify({ assets: [{
    name: 'ElyOffice-0.1.17-windows-x86_64-setup.exe',
    size: 249644317,
    digest: 'sha256:c2da2d2d2e24bc4f4609e9b06864a020cb163af519cf7c62eb1d17df6fa62bbd',
  }] }) };
  let api = sizes;
  const plugin = loadPlugin({
    fetchRoutes: (url, req) => (url.startsWith('https://api.github.com/') ? api : releaseFiles(url, req)),
    downloads: (req) => (req.bytes ? { ok: true, token: 't', bytes: req.bytes } : { ok: false, message: LEGACY }),
  });
  const rel = await plugin.context.checkLatest(true);
  const d = await plugin.context.downloadInstaller(rel, 'elyoffice-test');
  assert.equal(d.ok, true);
  assert.deepEqual(plugin.starts.map((s) => s.bytes), [undefined, 249644317]);
  assert.equal(plugin.requests.filter((r) => r.url.startsWith('https://api.github.com/')).length, 1);

  // 补查大小时被限流，要如实告诉用户，而不是「连不上 GitHub」。
  const limited = await plugin.context.checkLatest(true);
  api = { ok: true, status: 403, body: '{"message":"API rate limit exceeded for 203.0.113.9."}' };
  await assert.rejects(plugin.context.downloadInstaller(limited, 'elyoffice-test'), (e) => e.errorCode === 'GITHUB_RATE_LIMITED');
});

test('offers a manual download link after an automatic install fails and clears it once installed by hand', async () => {
  const plugin = loadPlugin({
    fetchRoutes: (url, req) => (url.startsWith('https://api.github.com/')
      ? { ok: true, status: 403, body: '{"message":"API rate limit exceeded for 203.0.113.9."}' }
      : releaseFiles(url, req)),
    downloads: () => ({ ok: false, message: LEGACY }),
  });
  await plugin.context.runInstall();
  let state = plugin.context.buildState();
  assert.equal(state.job.phase, 'error');
  assert.equal(state.job.errorCode, 'GITHUB_RATE_LIMITED');
  // 签名清单已经拿到：直接给这台电脑的安装包地址（普通下载地址，不受 API 限流）。
  assert.deepEqual(JSON.parse(JSON.stringify(state.manualDownload)), {
    url: `${RELEASES}download/v0.1.17/ElyOffice-0.1.17-windows-x86_64-setup.exe`,
    direct: true,
    version: '0.1.17',
  });
  // 用户自己装好后回到设置页：重新检测到已装最新版，收起上次的失败。
  plugin.installed.value = true;
  plugin.installed.version = '0.1.17';
  state = await plugin.context.handleAction('state');
  assert.equal(state.installed, true);
  assert.equal(state.job.phase, 'idle');
});

test('falls back to the releases page when even the signed manifest could not be fetched', async () => {
  const plugin = loadPlugin({
    fetchRoutes: () => ({ ok: false, message: 'getaddrinfo ENOTFOUND github.com' }),
    downloads: () => assert.fail('no download expected'),
  });
  await plugin.context.runInstall();
  const state = plugin.context.buildState();
  assert.equal(state.job.errorCode, 'NETWORK_FAILED');
  assert.equal(state.manualDownload.url, `${RELEASES}latest`);
  assert.equal(state.manualDownload.direct, false);
});
