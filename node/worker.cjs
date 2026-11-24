'use strict';
/**
 * ElyOffice 插件的本机后台（JSON-RPC over stdio，一行一个消息）。
 *
 * 负责：检测 ElyOffice 安装、核对官方版本清单签名、运行 / 跟踪安装与卸载、
 * 新建文档，调用 ely-doc / ely-table / ely-show / ely-mark 命令行读改已打开的文档。
 * 业务失败一律以 { ok:false, errorCode, message } 作为 result 返回；
 * JSON-RPC error 只用于协议层问题。stdout 只写协议消息，日志写 stderr。
 */

const readline = require('node:readline');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const ooxml = require('./ooxml.cjs');

const REPO = 'ELY-Open-Source/ElyOffice';
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
// ElyOffice 发布密钥公钥：crates/ely-platform/src/update/signature.rs（KEY）。
// 签名内容 = 文件名 + "\n" + 文件字节，算法 ed25519。
const RELEASE_PUBLIC_KEY = 'mK2fTwN43B6zYjAJlrMLyz1qTGayGcGZ/fPHokXOHro=';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const APPS = {
  word: {
    slug: 'ely-doc', name: 'ElyDoc', verb: 'text', label: 'Word 文档', multiWindow: true,
    exts: ['.docx', '.doc', '.docm', '.dotx', '.dotm', '.dot', '.odt', '.fodt', '.rtf'],
  },
  excel: {
    slug: 'ely-table', name: 'ElyTable', verb: 'cell', label: 'Excel 表格', multiWindow: true,
    exts: ['.xlsx', '.xls', '.xlsm', '.xltx', '.xltm', '.ods', '.fods', '.csv'],
  },
  ppt: {
    slug: 'ely-show', name: 'ElyShow', verb: 'text', label: 'PPT 演示文稿', multiWindow: true,
    exts: ['.pptx', '.ppt', '.pptm', '.potx', '.potm', '.ppsx', '.pps', '.odp', '.fodp'],
  },
  markdown: {
    // ElyMark 只有一个窗口，不认 --new-window。
    slug: 'ely-mark', name: 'ElyMark', verb: 'text', label: 'Markdown 文档', multiWindow: false,
    exts: ['.md', '.markdown'],
  },
  // ElyPDF 没有命令行，只能打开给用户看。
  pdf: {
    slug: 'ely-pdf', name: 'ElyPDF', verb: null, label: 'PDF', multiWindow: true,
    exts: ['.pdf'],
  },
};
// 有命令行、能读改的应用。
const EDITABLE_KINDS = Object.keys(APPS).filter((k) => APPS[k].verb);
// 能新建的格式：Word / Excel / PPT 以 ElyOffice 自带的空白文件为底，Markdown 是纯文字。
const CREATABLE = { '.docx': 'word', '.xlsx': 'excel', '.pptx': 'ppt', '.md': 'markdown', '.markdown': 'markdown' };
const ALL_APP_NAMES = ['ElyDoc', 'ElyTable', 'ElyShow', 'ElyPDF', 'ElyMail', 'ElyTree', 'ElyMark'];
const GUI_SLUGS = ['ely-doc', 'ely-table', 'ely-show', 'ely-pdf', 'ely-mail', 'ely-tree', 'ely-mark'];
const SLUG_TO_NAME = {
  'ely-doc': 'ElyDoc', 'ely-table': 'ElyTable', 'ely-show': 'ElyShow', 'ely-pdf': 'ElyPDF',
  'ely-mail': 'ElyMail', 'ely-tree': 'ElyTree', 'ely-mark': 'ElyMark',
};

const WORK_DIR = path.join(os.tmpdir(), 'cindy-elyoffice');
const STATE_FILE = path.join(WORK_DIR, 'job-state.json');
const INSTALL_FOOTPRINT_BYTES = 1300 * 1024 * 1024; // 装好后约 1 GB，留余量

function log(...args) {
  process.stderr.write(`[elyoffice] ${args.map(String).join(' ')}\n`);
}

class BizError extends Error {
  constructor(errorCode, message, detail) {
    super(message);
    this.errorCode = errorCode;
    this.detail = detail || null;
  }
}

// ───────────────────────── 通用工具 ─────────────────────────

// Cindy 只给插件后台传一份精简的环境变量，里面没有登录名（Windows 的 USERNAME，
// macOS / Linux 的 USER、LOGNAME）。ElyOffice 的文档引擎启动时要读它，缺了就报
// 「no USERNAME」起不来。启动 ElyOffice 和调它的命令行时，从系统账户信息补上。
function withLoginName(base, platform = process.platform, userInfo = os.userInfo) {
  const env = { ...base };
  let name = null;
  try {
    name = userInfo().username || null;
  } catch {
    name = null;
  }
  if (!name) return env;
  if (platform === 'win32') {
    if (!env.USERNAME) env.USERNAME = name;
  } else {
    if (!env.USER) env.USER = name;
    if (!env.LOGNAME) env.LOGNAME = name;
  }
  return env;
}

let childEnvCache = null;
function childEnv() {
  if (!childEnvCache) childEnvCache = withLoginName(process.env);
  return childEnvCache;
}

function run(file, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: childEnv() },
      (error, stdout, stderr) => {
        let code = 0;
        let spawnError = null;
        if (error) {
          if (typeof error.code === 'number') code = error.code;
          else {
            code = -1;
            spawnError = String(error.message || error);
          }
        }
        resolve({
          code,
          stdout: stdout || '',
          stderr: (stderr || '').trim(),
          spawnError,
          timedOut: Boolean(error && error.killed),
        });
      },
    );
  });
}

function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function platformKey() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x86_64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x86_64';
  return null;
}

function installSupported() {
  return (process.platform === 'win32' && process.arch === 'x64') || process.platform === 'darwin';
}

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function normalizePath(p) {
  let s = String(p || '').trim();
  if (process.platform === 'win32') {
    s = s.replace(/^\\\\\?\\/, '').replace(/\//g, '\\');
    return path.win32.resolve(s).toLowerCase();
  }
  return path.resolve(s);
}

function realOrSelf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

// 同一个文件可能经链接或不同大小写的路径传进来，ElyOffice 报回的是它自己解析后的路径。
function samePath(a, b) {
  return normalizePath(a) === normalizePath(b) || normalizePath(realOrSelf(a)) === normalizePath(realOrSelf(b));
}

function kindOf(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  for (const [kind, app] of Object.entries(APPS)) {
    if (app.exts.includes(ext)) return kind;
  }
  return null;
}

function requireAbsoluteFile(file) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new BizError('INVALID_PATH', '请提供文件的完整路径（绝对路径）。');
  }
  const p = file.trim();
  const isAbs = process.platform === 'win32' ? path.win32.isAbsolute(p) : path.isAbsolute(p);
  if (!isAbs) {
    throw new BizError('INVALID_PATH', `「${p}」不是完整路径。请传文件的绝对路径。`);
  }
  if (!exists(p)) {
    throw new BizError(
      'FILE_NOT_FOUND',
      `在这台电脑上找不到「${p}」。ElyOffice 插件只能处理装有插件的这台电脑上的文件。`,
    );
  }
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 安装检测 ─────────────────────────

const PS_DETECT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$r=@{root=$null;version=$null;uninstall=$null;apps=@{}}',
  "$k=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Ely Office'",
  'if($k){$r.root=$k.Root}',
  "$u=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Ely Office'",
  'if($u){$r.version=$u.DisplayVersion;$r.uninstall=$u.UninstallString}',
  `foreach($n in '${ALL_APP_NAMES.join("','")}'){$a=Get-ItemProperty -LiteralPath ('HKCU:\\Software\\Ely Office\\'+$n);if($a -and $a.InstallDir){$r.apps[$n]=$a.InstallDir}}`,
  '$r|ConvertTo-Json -Compress -Depth 4',
].join(';');

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return exists(full) ? full : 'powershell.exe';
}

async function detectWindows() {
  const res = await run(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_DETECT],
    { timeoutMs: 20000 },
  );
  let reg = { root: null, version: null, uninstall: null, apps: {} };
  try {
    const text = res.stdout.trim();
    if (text) reg = { ...reg, ...JSON.parse(text) };
  } catch (error) {
    log('detect parse failed', error.message, res.stderr);
  }
  const fallbackRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ely Office') : null;
  const root = reg.root || (exists(fallbackRoot) ? fallbackRoot : null);
  const apps = {};
  for (const [kind, app] of Object.entries(APPS)) {
    const dir = (reg.apps && reg.apps[app.name]) || (root ? path.join(root, app.name) : null);
    const exe = dir ? path.join(dir, `${app.slug}.exe`) : null;
    const launcher = dir ? path.join(dir, `${app.slug}-start.exe`) : null;
    apps[kind] = {
      name: app.name,
      installed: exists(exe),
      exe: exists(exe) ? exe : null,
      launcher: exists(launcher) ? launcher : null,
    };
  }
  const uninstaller = root && exists(path.join(root, 'uninstall.exe')) ? path.join(root, 'uninstall.exe') : null;
  return { root, version: reg.version || null, apps, uninstaller };
}

function readPlistVersion(appPath) {
  try {
    const xml = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const m = xml.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function detectMac() {
  const bases = ['/Applications', path.join(os.homedir(), 'Applications')];
  const apps = {};
  let version = null;
  for (const [kind, app] of Object.entries(APPS)) {
    let appPath = null;
    for (const base of bases) {
      const candidate = path.join(base, `${app.name}.app`);
      if (exists(candidate)) {
        appPath = candidate;
        break;
      }
    }
    const exe = appPath ? path.join(appPath, 'Contents', 'MacOS', app.slug) : null;
    const ok = exists(exe);
    apps[kind] = { name: app.name, installed: ok, exe: ok ? exe : null, appPath };
    if (ok && !version) version = readPlistVersion(appPath);
  }
  return { root: null, version, apps, uninstaller: null };
}

async function detectLinux() {
  const dirs = (process.env.PATH || '').split(':').concat(['/usr/bin', '/usr/local/bin', '/opt/ely-office/bin']);
  const apps = {};
  for (const [kind, app] of Object.entries(APPS)) {
    let exe = null;
    for (const dir of dirs) {
      const candidate = dir ? path.join(dir, app.slug) : null;
      if (candidate && exists(candidate)) {
        exe = candidate;
        break;
      }
    }
    apps[kind] = { name: app.name, installed: Boolean(exe), exe };
  }
  return { root: null, version: null, apps, uninstaller: null };
}

let detectCache = null;
async function detect(force = false) {
  if (!force && detectCache && Date.now() - detectCache.at < 4000) return detectCache.value;
  let info;
  if (process.platform === 'win32') info = await detectWindows();
  else if (process.platform === 'darwin') info = await detectMac();
  else info = await detectLinux();
  const installed = Object.values(info.apps).some((a) => a.installed);
  const value = {
    platform: process.platform,
    arch: process.arch,
    platformKey: platformKey(),
    installSupported: installSupported(),
    installed,
    ...info,
  };
  detectCache = { at: Date.now(), value };
  return value;
}

async function requireApp(kind) {
  const det = await detect();
  const app = det.apps[kind];
  if (!det.installed || !app || !app.installed) {
    throw new BizError(
      'ELYOFFICE_NOT_INSTALLED',
      det.installed
        ? `这台电脑上的 ElyOffice 缺少 ${APPS[kind].name}。请在「插件 → ElyOffice」设置页重新安装。`
        : '这台电脑上还没有安装 ElyOffice。请打开「插件 → ElyOffice」设置页一键安装，装好后再试。',
    );
  }
  return app;
}

// ───────────────────────── 命令行调用 ─────────────────────────

function isNotRunning(text) {
  // ElyMark 没开时直接说「ElyMark is not running」，其余应用报连接被拒。
  return /10061|10054|refused|积极拒绝|强迫关闭|os error 2\b|os error 61\b|os error 111\b|No such file or directory|is not running/i.test(text);
}

async function listDocs(kind) {
  const det = await detect();
  const app = det.apps[kind];
  if (!app || !app.exe || !APPS[kind].verb) return { running: false, docs: [] };
  const res = await run(app.exe, [APPS[kind].verb, 'docs'], { timeoutMs: 15000 });
  if (res.code === 0) {
    const docs = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { running: true, docs };
  }
  const text = `${res.stderr} ${res.spawnError || ''}`;
  if (isNotRunning(text)) return { running: false, docs: [] };
  throw new BizError('ELYOFFICE_CLI_FAILED', `读取 ${APPS[kind].name} 已打开的文件失败：${text.trim() || `退出码 ${res.code}`}`);
}

async function findOpenPath(kind, file) {
  const { docs } = await listDocs(kind);
  return docs.find((d) => samePath(d, file)) || null;
}

function launchCommand(kind, app, file, { newWindow = false, platform = process.platform } = {}) {
  const meta = APPS[kind];
  const extra = newWindow && meta.multiWindow ? ['--new-window'] : [];
  if (platform === 'darwin') {
    // 经 open 打开时 ElyOffice 不认 --new-window，要新窗口就直接运行程序。
    return newWindow ? { cmd: app.exe, args: [...extra, file] } : { cmd: '/usr/bin/open', args: ['-a', app.appPath, file] };
  }
  if (platform === 'win32' && app.launcher) {
    // 与 ElyOffice 安装时登记的「打开方式」命令一致：<slug>-start.exe <slug> <Name> "<file>"
    return { cmd: app.launcher, args: [meta.slug, meta.name, ...extra, file] };
  }
  return { cmd: app.exe, args: [...extra, file] };
}

function launchApp(kind, app, file, options) {
  const { cmd, args } = launchCommand(kind, app, file, options);
  // GUI 程序不能带 windowsHide，否则首个窗口可能被隐藏。
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env: childEnv() });
  child.on('error', (error) => log('launch failed', APPS[kind].name, error.message));
  child.unref();
}

const SUPPORTED_TYPES = 'Word、Excel、PPT、Markdown 或 PDF';

async function openDocument(file, { waitMs = 60000, newWindow = false } = {}) {
  const p = requireAbsoluteFile(file);
  const kind = kindOf(p);
  if (!kind) {
    throw new BizError(
      'UNSUPPORTED_FILE_TYPE',
      `ElyOffice 插件只处理 ${SUPPORTED_TYPES} 文件，「${path.basename(p)}」不在其中。`,
    );
  }
  const app = await requireApp(kind);
  const note = newWindow && !APPS[kind].multiWindow ? { newWindowIgnored: `${APPS[kind].name} 只有一个窗口，已在原窗口打开。` } : {};
  if (!APPS[kind].verb) {
    // 没有命令行的应用（ElyPDF）无法确认是否已打开，拉起后直接返回。
    launchApp(kind, app, p, { newWindow });
    return { kind, app: APPS[kind].name, path: p, launched: true, readable: false, ...note };
  }
  const already = await findOpenPath(kind, p);
  launchApp(kind, app, p, { newWindow }); // 已打开时 ElyOffice 会把那个窗口提到前面
  if (already) return { kind, app: APPS[kind].name, path: already, alreadyOpen: true, openedNow: false, ...note };
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    await sleep(700);
    const found = await findOpenPath(kind, p).catch(() => null);
    if (found) return { kind, app: APPS[kind].name, path: found, alreadyOpen: false, openedNow: true, ...note };
  }
  throw new BizError(
    'OPEN_TIMEOUT',
    `${APPS[kind].name} 还没有打开「${path.basename(p)}」。可能文件较大仍在载入，或窗口里有需要用户确认的提示，请让用户看一下 ElyOffice 窗口后再试。`,
  );
}

// Cindy 的「用默认应用打开」交给插件时用:只负责拉起 ElyOffice,不等文件出现在已打开列表里
// (Cindy 只等约 15 秒)。没装或类型不对时抛错,由 Cindy 改用系统默认应用。
async function launchDocument(file) {
  const p = requireAbsoluteFile(file);
  const kind = kindOf(p);
  if (!kind) throw new BizError('UNSUPPORTED_FILE_TYPE', `「${path.basename(p)}」不是 ${SUPPORTED_TYPES} 文件。`);
  const app = await requireApp(kind);
  launchApp(kind, app, p);
  return { kind, app: APPS[kind].name, launched: true };
}

async function ensureOpen(file, expectKinds) {
  const p = requireAbsoluteFile(file);
  const kind = kindOf(p);
  if (!kind || (expectKinds && !expectKinds.includes(kind))) {
    const want = (expectKinds || Object.keys(APPS)).map((k) => APPS[k].label).join('、');
    throw new BizError('UNSUPPORTED_FILE_TYPE', `这个操作只适用于 ${want}，「${path.basename(p)}」不是。`);
  }
  await requireApp(kind);
  const open = await findOpenPath(kind, p);
  if (open) return { kind, path: open, openedNow: false };
  const opened = await openDocument(p);
  return { kind, path: opened.path, openedNow: true };
}

function cliFailure(kind, res, action) {
  const text = `${res.stderr} ${res.spawnError || ''}`.trim();
  if (isNotRunning(text)) {
    return new BizError('ELYOFFICE_NOT_RUNNING', `${APPS[kind].name} 刚刚被关闭了，请重新打开文件后再试。`);
  }
  if (/is not open in/i.test(text)) {
    return new BizError('DOCUMENT_NOT_OPEN', `这个文件已经不在 ${APPS[kind].name} 里打开了，请重新打开后再试。`);
  }
  if (/changed on disk/i.test(text)) {
    return new BizError(
      'DISK_CHANGED',
      `文件在打开后被别的程序改过，${APPS[kind].name} 没有覆盖它。请让用户在 ElyOffice 窗口里决定保留哪个版本。`,
    );
  }
  if (/shows as a preview/i.test(text)) {
    return new BizError(
      'MARKDOWN_PREVIEW',
      'ElyMark 正以预览模式显示这个文件，预览里不能改。请用户切到编辑或源码模式（Ctrl+/，macOS 为 Cmd+/）后再试。',
    );
  }
  if (res.timedOut) return new BizError('ELYOFFICE_TIMEOUT', `${APPS[kind].name} ${action}超时，请稍后再试。`);
  return new BizError('ELYOFFICE_CLI_FAILED', `${APPS[kind].name} ${action}失败：${text || `退出码 ${res.code}`}`);
}

async function cli(kind, args, action, timeoutMs = 60000) {
  const app = await requireApp(kind);
  const res = await run(app.exe, [APPS[kind].verb, ...args], { timeoutMs });
  if (res.code !== 0) throw cliFailure(kind, res, action);
  return res.stdout;
}

function countOccurrences(text, find) {
  let n = 0;
  for (const line of String(text).split(/\r?\n|\f/)) {
    let i = line.indexOf(find);
    while (i !== -1) {
      n += 1;
      i = line.indexOf(find, i + find.length);
    }
  }
  return n;
}

// ElyMark 的替换对整篇 Markdown 原文逐处匹配（可跨行），不按段落切开。
function countAll(text, find) {
  let n = 0;
  let i = String(text).indexOf(find);
  while (i !== -1) {
    n += 1;
    i = text.indexOf(find, i + find.length);
  }
  return n;
}

const MAX_TEXT_CHARS = 200000;
const TEXT_KINDS = ['word', 'ppt', 'markdown'];

async function readDocument(file) {
  const { kind, path: p, openedNow } = await ensureOpen(file, TEXT_KINDS);
  const raw = await cli(kind, ['get', p], '读取内容');
  const text = raw.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const truncated = text.length > MAX_TEXT_CHARS;
  const shown = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;
  const result = { kind, app: APPS[kind].name, path: p, openedNow, truncated };
  if (kind === 'ppt') {
    result.slides = shown.split('\f').map((s, i) => ({ slide: i + 1, text: s.replace(/^\n+|\n+$/g, '') }));
  } else {
    result.text = shown;
  }
  return result;
}

async function replaceText(file, replacements) {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new BizError('INVALID_ARGS', 'replacements 至少要有一项 { find, replace }。');
  }
  if (replacements.length > 50) throw new BizError('INVALID_ARGS', '一次最多 50 处替换，请分批进行。');
  for (const r of replacements) {
    if (!r || typeof r.find !== 'string' || !r.find || typeof r.replace !== 'string') {
      throw new BizError('INVALID_ARGS', '每项替换都要有非空的 find 和字符串 replace。');
    }
  }
  const { kind, path: p, openedNow } = await ensureOpen(file, TEXT_KINDS);
  const markdown = kind === 'markdown';
  if (!markdown) {
    for (const r of replacements) {
      if (/[\r\n\f]/.test(r.find) || /[\r\n\f]/.test(r.replace)) {
        throw new BizError('INVALID_ARGS', 'Word 和 PPT 只能在同一段内替换文字，find 和 replace 不能包含换行。');
      }
    }
  }
  const notFound = markdown ? '文档里没有找到这段文字（区分大小写）' : '文档里没有找到这段文字（区分大小写，不跨段）';
  const results = [];
  for (const r of replacements) {
    const before = await cli(kind, ['get', p], '读取内容');
    const count = markdown ? countAll(before, r.find) : countOccurrences(before, r.find);
    if (count === 0) {
      results.push({ find: r.find, replace: r.replace, replaced: 0, note: notFound });
      continue;
    }
    const app = await requireApp(kind);
    const res = await run(app.exe, [APPS[kind].verb, 'replace', p, r.find, r.replace], { timeoutMs: 60000 });
    if (res.code !== 0) {
      if (/nothing replaced/i.test(res.stderr)) {
        results.push({ find: r.find, replace: r.replace, replaced: 0, note: notFound });
        continue;
      }
      throw cliFailure(kind, res, '替换文字');
    }
    results.push({ find: r.find, replace: r.replace, replaced: count });
  }
  const total = results.reduce((s, r) => s + r.replaced, 0);
  return { kind, app: APPS[kind].name, path: p, openedNow, totalReplaced: total, results };
}

function requireAddress(address) {
  if (typeof address !== 'string' || !/^.+!\$?[A-Za-z]+\$?\d+(:\$?[A-Za-z]+\$?\d+)?$/.test(address.trim())) {
    throw new BizError(
      'INVALID_ADDRESS',
      `单元格地址「${address}」不对：要写明工作表名，如 Sheet1!B2；工作表名有空格时写成 'My Sheet'!B2。`,
    );
  }
  return address.trim();
}

// 一次读写的单元格上限：ElyTable 每格约 30 毫秒，500 格约 15 秒，在工具调用时限内。
const MAX_CELLS = 500;
const MAX_COLUMN = 16384; // XFD
const MAX_ROW = 1048576;

function columnNumber(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function columnLetters(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** 把 Sheet1!A1 或 Sheet1!A1:C3 拆成 { sheet, c1, r1, c2, r2 }。 */
function parseRange(address) {
  const a = requireAddress(address);
  const m = a.match(/^(.+)!\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/);
  if (!m) throw new BizError('INVALID_ADDRESS', `单元格地址「${address}」不对：列用字母、行用数字，如 Sheet1!B2 或 Sheet1!A1:F20。`);
  const c1 = columnNumber(m[2]);
  const r1 = Number(m[3]);
  const c2 = m[4] ? columnNumber(m[4]) : c1;
  const r2 = m[5] ? Number(m[5]) : r1;
  for (const [c, r] of [[c1, r1], [c2, r2]]) {
    if (c < 1 || c > MAX_COLUMN || r < 1 || r > MAX_ROW) {
      throw new BizError('INVALID_ADDRESS', `单元格地址「${address}」超出了表格范围（最多到 XFD 列、第 1048576 行）。`);
    }
  }
  return { sheet: m[1], c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
}

function cellAddress(sheet, col, row) {
  return `${sheet}!${columnLetters(col)}${row}`;
}

/** 把地址列表（可含区域）展开成逐格地址，按行优先，超过上限即报错。 */
function expandAddresses(addresses, limit = MAX_CELLS) {
  const out = [];
  for (const address of addresses) {
    const r = parseRange(address);
    const count = (r.c2 - r.c1 + 1) * (r.r2 - r.r1 + 1);
    if (out.length + count > limit) {
      throw new BizError('INVALID_ARGS', `一次最多读 ${limit} 个单元格，这次要读的超过了，请把区域分成几次读。`);
    }
    for (let row = r.r1; row <= r.r2; row += 1) {
      for (let col = r.c1; col <= r.c2; col += 1) out.push(cellAddress(r.sheet, col, row));
    }
  }
  return out;
}

const FORMULA_ERROR = /^(#[A-Z0-9/]+[!?]?|#N\/A|Err:\d+)$/;

function cellValue(value, where) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BizError('INVALID_ARGS', `${where} 的数字无效。`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value;
  throw new BizError('INVALID_ARGS', `${where} 要是文字、数字、TRUE/FALSE，或以 = 开头的公式。`);
}

async function getCell(p, address) {
  const out = await cli('excel', ['get', p, address], `读取 ${address} `);
  try {
    return JSON.parse(out);
  } catch {
    return { address, text: out.trim() };
  }
}

async function setCell(p, address, value, done) {
  const app = await requireApp('excel');
  const res = await run(app.exe, [APPS.excel.verb, 'set', p, address, value], { timeoutMs: 60000 });
  if (res.code === 0) return;
  const error = /undo history did not move/i.test(res.stderr)
    ? new BizError(
      'WRITE_FAILED',
      `ElyTable 没有写进 ${address}：最常见的原因是工作表「${address.slice(0, address.lastIndexOf('!'))}」不存在（插件不能新增工作表），或这一格所在的工作表受保护。`,
    )
    : cliFailure('excel', res, `写入 ${address} `);
  if (done > 0) {
    error.message += `（这次已经写好前 ${done} 格，可以在 ElyTable 里按 Ctrl+Z 逐格撤销。）`;
    error.detail = { written: done, failedAt: address };
  }
  throw error;
}

async function readCells(file, addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new BizError('INVALID_ARGS', 'addresses 至少要有一个单元格地址，如 ["Sheet1!A1"] 或 ["Sheet1!A1:F20"]。');
  }
  if (addresses.length > 200) throw new BizError('INVALID_ARGS', '一次最多给 200 个地址或区域。');
  const list = expandAddresses(addresses);
  const { path: p, openedNow } = await ensureOpen(file, ['excel']);
  const cells = [];
  for (const address of list) cells.push(await getCell(p, address));
  return { kind: 'excel', app: 'ElyTable', path: p, openedNow, cells };
}

async function writeCells(file, cells) {
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new BizError('INVALID_ARGS', 'cells 至少要有一项 { address, value }。');
  }
  if (cells.length > 200) throw new BizError('INVALID_ARGS', '一次最多写入 200 个单元格；整片写入请用 write_table。');
  const list = cells.map((c, i) => {
    if (!c) throw new BizError('INVALID_ARGS', '每项都要有 address 和 value（文字、数字或以 = 开头的公式）。');
    const address = requireAddress(c.address);
    if (address.includes(':')) throw new BizError('INVALID_ADDRESS', `write_cells 一项只写一格，「${address}」是区域；整片写入请用 write_table。`);
    return { address, value: cellValue(c.value, `第 ${i + 1} 项`) };
  });
  const { path: p, openedNow } = await ensureOpen(file, ['excel']);
  const written = [];
  for (const c of list) {
    await setCell(p, c.address, c.value, written.length);
    written.push(await getCell(p, c.address));
  }
  return { kind: 'excel', app: 'ElyTable', path: p, openedNow, cells: written };
}

/** 从左上角一格起，按行写入一片表格；null 的格子跳过不动。 */
function planTable(start, rows) {
  const anchor = parseRange(start);
  if (anchor.c1 !== anchor.c2 || anchor.r1 !== anchor.r2) {
    throw new BizError('INVALID_ADDRESS', `start 要是一格，如 Sheet1!A1；「${start}」是区域。`);
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new BizError('INVALID_ARGS', 'rows 要是二维数组，如 [["分类","预算"],["餐饮",2000]]。');
  const cells = [];
  let skipped = 0;
  let width = 0;
  rows.forEach((row, ri) => {
    if (!Array.isArray(row)) throw new BizError('INVALID_ARGS', `rows 的第 ${ri + 1} 行要是数组。`);
    width = Math.max(width, row.length);
    row.forEach((value, ci) => {
      if (value === null || value === undefined) {
        skipped += 1;
        return;
      }
      const col = anchor.c1 + ci;
      const r = anchor.r1 + ri;
      if (col > MAX_COLUMN || r > MAX_ROW) throw new BizError('INVALID_ARGS', '要写的内容超出了表格范围（最多到 XFD 列、第 1048576 行）。');
      cells.push({ address: cellAddress(anchor.sheet, col, r), value: cellValue(value, `第 ${ri + 1} 行第 ${ci + 1} 个值`) });
    });
  });
  if (!cells.length) throw new BizError('INVALID_ARGS', 'rows 里没有要写的值（null 表示跳过）。');
  if (cells.length > MAX_CELLS) throw new BizError('INVALID_ARGS', `一次最多写 ${MAX_CELLS} 格，这次有 ${cells.length} 格，请分几次写（每次换一个 start）。`);
  const range = `${anchor.sheet}!${columnLetters(anchor.c1)}${anchor.r1}:${columnLetters(anchor.c1 + Math.max(width, 1) - 1)}${anchor.r1 + rows.length - 1}`;
  return { cells, skipped, range };
}

async function writeTable(file, start, rows) {
  const plan = planTable(start, rows);
  const { path: p, openedNow } = await ensureOpen(file, ['excel']);
  let done = 0;
  for (const c of plan.cells) {
    await setCell(p, c.address, c.value, done);
    done += 1;
  }
  // 公式写完回读一次，让 AI 看到算出来的结果，发现 #NAME? 之类的错误。
  const formulas = [];
  for (const c of plan.cells) {
    if (c.value.startsWith('=')) formulas.push(await getCell(p, c.address));
  }
  const formulaErrors = formulas.filter((f) => FORMULA_ERROR.test(String(f.text || '').trim()));
  return {
    kind: 'excel', app: 'ElyTable', path: p, openedNow,
    range: plan.range, written: done, skipped: plan.skipped, formulas, formulaErrors,
  };
}

async function saveDocument(file) {
  const p0 = requireAbsoluteFile(file);
  const kind = kindOf(p0);
  if (!kind) throw new BizError('UNSUPPORTED_FILE_TYPE', `「${path.basename(p0)}」不是 ${SUPPORTED_TYPES} 文件。`);
  if (!APPS[kind].verb) throw new BizError('UNSUPPORTED_FILE_TYPE', 'PDF 在 ElyPDF 里只能查看，插件不能保存它。');
  await requireApp(kind);
  const p = await findOpenPath(kind, p0);
  if (!p) {
    throw new BizError('DOCUMENT_NOT_OPEN', `「${path.basename(p0)}」没有在 ${APPS[kind].name} 里打开，没有可保存的改动。`);
  }
  const out = await cli(kind, ['save', p], '保存');
  return { kind, app: APPS[kind].name, path: p, savedTo: out.trim() || p };
}

// ───────────────────────── 新建文档 ─────────────────────────

function documentsDir() {
  const home = os.homedir();
  const docs = path.join(home, 'Documents');
  return exists(docs) ? docs : home;
}

/** 新文件的位置：完整路径照用；只给文件名时放进用户的「文档」文件夹。 */
function resolveNewPath(input, platform = process.platform) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new BizError('INVALID_PATH', '请给新文件的完整路径，或只给文件名（会放进「文档」文件夹）。');
  }
  const s = input.trim();
  const isAbs = platform === 'win32' ? path.win32.isAbsolute(s) : path.posix.isAbsolute(s);
  if (isAbs) return s;
  if (/[\\/]/.test(s)) {
    throw new BizError('INVALID_PATH', `「${s}」不是完整路径。请给完整路径，或只给文件名（会放进「文档」文件夹）。`);
  }
  return path.join(documentsDir(), s);
}

const CONTENT_PARAMS = { sheets: 'excel', paragraphs: 'word', slides: 'ppt', text: 'markdown' };

function given(v) {
  return v !== undefined && v !== null;
}

/** 校验参数并生成新文件的内容，不碰磁盘。 */
function planCreate(params, platform = process.platform) {
  const p = params || {};
  const target = resolveNewPath(p.path, platform);
  const ext = path.extname(target).toLowerCase();
  if (given(p.from) && p.from !== '') {
    const src = requireAbsoluteFile(p.from);
    const used = Object.keys(CONTENT_PARAMS).filter((k) => given(p[k]));
    if (used.length) {
      throw new BizError('INVALID_ARGS', `用 from 复制已有文件时，不能同时给 ${used.join('、')}；内容来自 from 这个文件。`);
    }
    const srcExt = path.extname(src).toLowerCase();
    if (srcExt !== ext) {
      throw new BizError('INVALID_ARGS', `新文件的扩展名要和 from 一样（${srcExt || '无扩展名'}），插件不做格式转换。`);
    }
    const kind = kindOf(src);
    if (!kind) throw new BizError('UNSUPPORTED_FILE_TYPE', `「${path.basename(src)}」不是 ${SUPPORTED_TYPES} 文件。`);
    return { target, kind, from: src };
  }
  const kind = CREATABLE[ext];
  if (!kind) {
    throw new BizError(
      'UNSUPPORTED_FILE_TYPE',
      '新建只支持 .docx、.xlsx、.pptx 和 .md。其他格式可以先用别的工具做好，再用 from 复制过来打开。',
    );
  }
  for (const [key, owner] of Object.entries(CONTENT_PARAMS)) {
    if (given(p[key]) && owner !== kind) {
      throw new BizError('INVALID_ARGS', `${key} 只用于新建 ${APPS[owner].label}，这次新建的是 ${APPS[kind].label}。`);
    }
  }
  try {
    if (kind === 'excel') {
      const r = ooxml.buildXlsx(p.sheets);
      return { target, kind, buffer: r.buffer, info: { sheets: r.sheets } };
    }
    if (kind === 'word') {
      const r = ooxml.buildDocx(p.paragraphs);
      return { target, kind, buffer: r.buffer, info: { paragraphs: r.paragraphs } };
    }
    if (kind === 'ppt') {
      const r = ooxml.buildPptx(p.slides);
      return { target, kind, buffer: r.buffer, info: { slides: r.slides } };
    }
    return { target, kind, buffer: ooxml.buildMarkdown(p.text).buffer, info: {} };
  } catch (error) {
    if (error instanceof ooxml.InputError) throw new BizError('INVALID_ARGS', error.message);
    throw error;
  }
}

function writeFailure(error, target) {
  if (error && error.code === 'EEXIST') {
    return new BizError('FILE_EXISTS', `「${target}」已经存在，插件不会覆盖它。请换个文件名，或用 open_document 打开它。`);
  }
  if (error && (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS')) {
    return new BizError('PERMISSION_DENIED', `没有权限在「${path.dirname(target)}」里新建文件，请换个位置。`);
  }
  if (error && (error.code === 'ENOENT' || error.code === 'EINVAL' || error.code === 'ENOTDIR' || error.code === 'ENAMETOOLONG')) {
    return new BizError('INVALID_PATH', `不能用「${target}」这个路径新建文件：文件名里可能有系统不允许的字符，或路径不对。`);
  }
  return error;
}

async function createDocument(params) {
  const p = params || {};
  const plan = planCreate(p);
  if (exists(plan.target)) throw writeFailure({ code: 'EEXIST' }, plan.target);
  const openAfter = p.open !== false;
  if (openAfter) await requireApp(plan.kind);
  try {
    await fsp.mkdir(path.dirname(plan.target), { recursive: true });
    if (plan.from) await fsp.copyFile(plan.from, plan.target, fs.constants.COPYFILE_EXCL);
    else await fsp.writeFile(plan.target, plan.buffer, { flag: 'wx' });
  } catch (error) {
    throw writeFailure(error, plan.target);
  }
  const result = { kind: plan.kind, app: APPS[plan.kind].name, path: plan.target, created: true, ...(plan.from ? { from: plan.from } : {}), ...plan.info };
  if (!openAfter) return { ...result, opened: false };
  try {
    const opened = await openDocument(plan.target, { newWindow: p.newWindow === true });
    const note = opened.newWindowIgnored ? { newWindowIgnored: opened.newWindowIgnored } : {};
    return { ...result, path: opened.path || plan.target, opened: true, ...note };
  } catch (error) {
    if (!(error instanceof BizError)) throw error;
    // 文件已经建好，只是没能打开：如实返回，让 AI 告诉用户文件在哪。
    return { ...result, opened: false, openErrorCode: error.errorCode, openError: error.message };
  }
}

// ───────────────────────── 运行中的应用 ─────────────────────────

async function runningApps() {
  const names = new Set();
  if (process.platform === 'win32') {
    const res = await run('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 15000 });
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/);
      if (!m) continue;
      const image = m[1].toLowerCase().replace(/\.exe$/, '');
      if (GUI_SLUGS.includes(image)) names.add(image);
    }
  } else {
    const res = await run('ps', ['-axo', 'comm='], { timeoutMs: 15000 });
    for (const line of res.stdout.split(/\r?\n/)) {
      const base = path.basename(line.trim());
      if (GUI_SLUGS.includes(base)) names.add(base);
    }
  }
  const running = [];
  for (const slug of names) {
    const entry = { app: SLUG_TO_NAME[slug], docs: [] };
    const kind = Object.keys(APPS).find((k) => APPS[k].slug === slug);
    if (kind) {
      const docs = await listDocs(kind).catch(() => ({ docs: [] }));
      entry.docs = docs.docs.map((d) => path.basename(d));
    }
    running.push(entry);
  }
  return running;
}

async function status() {
  const det = await detect(true);
  const openDocuments = {};
  if (det.installed) {
    for (const kind of EDITABLE_KINDS) {
      if (!det.apps[kind].installed) continue;
      const r = await listDocs(kind).catch(() => ({ running: false, docs: [] }));
      openDocuments[kind] = r.docs;
    }
  }
  return {
    installed: det.installed,
    version: det.version,
    platform: det.platform,
    apps: Object.fromEntries(Object.entries(det.apps).map(([k, a]) => [k, { name: a.name, installed: a.installed }])),
    openDocuments,
  };
}

// ───────────────────────── 版本清单与安装 ─────────────────────────

function verifyManifest({ name, manifest, signature, platformKey: key }) {
  if (typeof name !== 'string' || !/^ely-office-[a-z0-9_-]+\.json$/.test(name)) {
    throw new BizError('MANIFEST_INVALID', '版本清单文件名不对。');
  }
  if (typeof manifest !== 'string' || typeof signature !== 'string') {
    throw new BizError('MANIFEST_INVALID', '没有取到完整的版本清单或签名。');
  }
  const bytes = Buffer.from(manifest, 'utf8');
  const sig = Buffer.from(signature.trim(), 'base64');
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(RELEASE_PUBLIC_KEY, 'base64')]),
    format: 'der',
    type: 'spki',
  });
  const message = Buffer.concat([Buffer.from(name, 'utf8'), Buffer.from('\n'), bytes]);
  let valid = false;
  try {
    valid = sig.length === 64 && crypto.verify(null, message, publicKey, sig);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new BizError('SIGNATURE_INVALID', '版本清单没有通过 ElyOffice 官方签名核对，已停止，没有下载任何文件。');
  }
  let parsed;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    throw new BizError('MANIFEST_INVALID', '版本清单格式不对。');
  }
  const asset = parsed && parsed.assets && parsed.assets[key];
  if (!asset || typeof asset.url !== 'string' || typeof asset.sha256 !== 'string') {
    throw new BizError('UNSUPPORTED_PLATFORM', '最新版本没有提供这台电脑可用的安装包。');
  }
  if (!asset.url.startsWith(DOWNLOAD_PREFIX) || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new BizError('MANIFEST_INVALID', '版本清单里的下载地址或校验值不符合预期，已停止。');
  }
  const assetName = decodeURIComponent(asset.url.split('/').pop() || '');
  if (!/^[\w.-]+$/.test(assetName)) throw new BizError('MANIFEST_INVALID', '安装包文件名不符合预期。');
  return { version: String(parsed.version || ''), url: asset.url, sha256: asset.sha256, assetName };
}

async function freeBytes(dir) {
  try {
    let d = dir;
    while (d && !exists(d)) {
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    if (typeof fsp.statfs !== 'function') return null;
    const st = await fsp.statfs(d);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

async function diskCheck({ bytes }) {
  const det = await detect();
  let installDir = det.root;
  if (!installDir) {
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) installDir = path.join(process.env.LOCALAPPDATA, 'Programs');
    else if (process.platform === 'darwin') installDir = '/Applications';
    else installDir = os.homedir();
  }
  const size = Number(bytes) || 0;
  const [tmpFree, installFree] = await Promise.all([freeBytes(os.tmpdir()), freeBytes(installDir)]);
  const volume = (p) => path.parse(path.resolve(p)).root.toLowerCase();
  const sameVolume = process.platform === 'win32' ? volume(os.tmpdir()) === volume(installDir) : false;
  const problems = [];
  if (sameVolume) {
    if (installFree !== null && installFree < INSTALL_FOOTPRINT_BYTES + size) {
      problems.push({ where: installDir, need: INSTALL_FOOTPRINT_BYTES + size, free: installFree });
    }
  } else {
    if (tmpFree !== null && tmpFree < size * 1.1) problems.push({ where: os.tmpdir(), need: size, free: tmpFree });
    if (installFree !== null && installFree < INSTALL_FOOTPRINT_BYTES) {
      problems.push({ where: installDir, need: INSTALL_FOOTPRINT_BYTES, free: installFree });
    }
  }
  if (problems.length) {
    const gb = (n) => (n / 1024 ** 3).toFixed(1);
    const p = problems[0];
    const drive = volume(p.where).toUpperCase() || p.where;
    throw new BizError(
      'DISK_FULL',
      `磁盘空间不够：安装 ElyOffice 还需要约 ${gb(p.need)} GB，${drive} 只剩 ${gb(p.free)} GB。请先清理一些空间。`,
      { needGb: gb(p.need), freeGb: gb(p.free), drive },
    );
  }
  return { enough: true };
}

let currentChild = null; // { pid, exitCode }

function readJobState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeJobState(state) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function clearJobState(state) {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {}
  if (state && state.file) {
    const dir = path.dirname(state.file);
    // 只删自己建的安装包副本目录
    if (path.dirname(dir) === WORK_DIR && /^install-\d+$/.test(path.basename(dir))) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

async function startInstall(params) {
  if (!installSupported()) throw new BizError('UNSUPPORTED_PLATFORM', '这台电脑暂不支持一键安装 ElyOffice。');
  const existing = readJobState();
  if (existing && existing.mode === 'pid' && pidAlive(existing.pid)) {
    throw new BizError('JOB_RUNNING', '已经有一个 ElyOffice 安装在进行中，请稍候。');
  }
  if (existing) clearJobState(existing);
  const src = params && params.downloads && params.downloads.installer;
  const { version, sha256, assetName } = params || {};
  if (typeof src !== 'string' || !exists(src)) throw new BizError('DOWNLOAD_MISSING', '没有拿到下载好的安装包，请重新下载。');
  if (!/^[a-f0-9]{64}$/.test(String(sha256)) || !/^[\w.-]+$/.test(String(assetName))) {
    throw new BizError('INVALID_ARGS', '安装参数不完整。');
  }
  // 复制到独立临时目录后再次核对，之后只运行这份核对过的副本。
  const dir = path.join(WORK_DIR, `install-${Date.now()}`);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, assetName);
  await fsp.copyFile(src, file);
  const actual = await sha256File(file);
  if (actual !== sha256) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new BizError('CHECKSUM_MISMATCH', '安装包校验没有通过，已删除，请重新下载。');
  }
  if (process.platform === 'win32') {
    const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
    currentChild = { pid: child.pid, exitCode: null };
    child.on('exit', (code) => {
      if (currentChild && currentChild.pid === child.pid) currentChild.exitCode = code;
    });
    child.on('error', (error) => {
      log('installer spawn failed', error.message);
      if (currentChild && currentChild.pid === child.pid) currentChild.exitCode = -1;
    });
    child.unref();
    writeJobState({ kind: 'install', mode: 'pid', pid: child.pid, version, file, startedAt: Date.now() });
    return { started: true, phase: 'installing' };
  }
  // macOS：安装包装到「应用程序」，需要用户在系统安装器里确认并输入密码。
  const child = spawn('/usr/bin/open', [file], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => log('open pkg failed', error.message));
  child.unref();
  writeJobState({ kind: 'install', mode: 'watch', pid: 0, version, file, startedAt: Date.now() });
  return { started: true, phase: 'waiting-user' };
}

async function startUninstall() {
  if (process.platform !== 'win32') {
    throw new BizError('UNSUPPORTED_PLATFORM', '这台电脑上请用系统自带的方式卸载 ElyOffice（例如把应用拖到废纸篓）。');
  }
  const det = await detect(true);
  if (!det.installed) return { started: false, alreadyRemoved: true };
  if (!det.uninstaller) throw new BizError('UNINSTALLER_MISSING', '找不到 ElyOffice 的卸载程序，请在 Windows「设置 → 应用」里卸载。');
  const running = await runningApps();
  if (running.length) {
    throw new BizError('APPS_RUNNING', `请先保存并关闭 ElyOffice（${running.map((r) => r.app).join('、')}）后再卸载。`);
  }
  // 卸载程序会把自己复制到临时目录再运行，所以按安装登记是否消失判断完成。
  const child = spawn(det.uninstaller, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => log('uninstaller spawn failed', error.message));
  child.unref();
  writeJobState({ kind: 'uninstall', mode: 'watch', pid: child.pid, startedAt: Date.now() });
  return { started: true, phase: 'uninstalling' };
}

async function jobStatus() {
  const st = readJobState();
  if (!st) return { phase: 'idle' };
  const elapsed = Date.now() - (st.startedAt || 0);
  if (st.kind === 'install' && st.mode === 'pid') {
    const tracked = currentChild && currentChild.pid === st.pid;
    const alive = tracked ? currentChild.exitCode === null : pidAlive(st.pid);
    if (alive) return { phase: 'installing', version: st.version, startedAt: st.startedAt };
    const exitCode = tracked ? currentChild.exitCode : null;
    const det = await detect(true);
    const ok = det.installed && (!st.version || !det.version || cmpVersion(det.version, st.version) >= 0);
    clearJobState(st);
    currentChild = null;
    return ok
      ? { phase: 'done', kind: 'install', version: det.version || st.version }
      : { phase: 'failed', kind: 'install', exitCode, version: st.version };
  }
  const det = await detect(true);
  if (st.kind === 'install') {
    if (det.installed && (!st.version || !det.version || cmpVersion(det.version, st.version) >= 0)) {
      clearJobState(st);
      return { phase: 'done', kind: 'install', version: det.version || st.version };
    }
    if (elapsed > 60 * 60 * 1000) {
      clearJobState(st);
      return { phase: 'failed', kind: 'install', reason: 'timeout' };
    }
    return { phase: 'waiting-user', version: st.version, startedAt: st.startedAt };
  }
  if (st.kind === 'uninstall') {
    if (!det.installed) {
      clearJobState(st);
      return { phase: 'done', kind: 'uninstall' };
    }
    if (elapsed > 10 * 60 * 1000) {
      clearJobState(st);
      return { phase: 'failed', kind: 'uninstall', reason: 'timeout' };
    }
    return { phase: 'uninstalling', startedAt: st.startedAt };
  }
  clearJobState(st);
  return { phase: 'idle' };
}

function cancelWaiting() {
  const st = readJobState();
  if (st && st.mode === 'watch' && st.kind === 'install') clearJobState(st);
  return { cancelled: true };
}

// ───────────────────────── JSON-RPC ─────────────────────────

const METHODS = {
  detect: async (p) => detect(Boolean(p && p.force)),
  status: async () => status(),
  'apps/running': async () => ({ running: await runningApps() }),
  'release/verify': async (p) => verifyManifest(p || {}),
  // 清单与签名由 Cindy 下载（cindy.downloads，已按 GitHub 给的 SHA-256 核对），这里读文件再核对官方签名。
  'release/verify-files': async (p) => {
    const files = (p && p.downloads) || {};
    if (typeof files.manifest !== 'string' || typeof files.signature !== 'string') {
      throw new BizError('MANIFEST_INVALID', '没有取到完整的版本清单或签名。');
    }
    const [manifest, signature] = await Promise.all([
      fsp.readFile(files.manifest, 'utf8'),
      fsp.readFile(files.signature, 'utf8'),
    ]);
    return verifyManifest({ name: p.name, manifest, signature, platformKey: p.platformKey });
  },
  'disk/check': async (p) => diskCheck(p || {}),
  'install/start': async (p) => startInstall(p || {}),
  'install/cancel-wait': async () => cancelWaiting(),
  'uninstall/start': async () => startUninstall(),
  'job/status': async () => jobStatus(),
  'doc/open': async (p) => openDocument(p && p.path, { newWindow: Boolean(p && p.newWindow === true) }),
  'doc/launch': async (p) => launchDocument(p && p.path),
  'doc/create': async (p) => createDocument(p || {}),
  'doc/read': async (p) => readDocument(p && p.path),
  'doc/replace': async (p) => replaceText(p && p.path, p && p.replacements),
  'doc/save': async (p) => saveDocument(p && p.path),
  'cells/read': async (p) => readCells(p && p.path, p && p.addresses),
  'cells/write': async (p) => writeCells(p && p.path, p && p.cells),
  'cells/write-table': async (p) => writeTable(p && p.path, p && p.start, p && p.rows),
};

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(request) {
  const fn = Object.prototype.hasOwnProperty.call(METHODS, request.method) ? METHODS[request.method] : null;
  if (!fn) {
    if (request.id !== undefined) reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  try {
    const result = await fn(request.params || {});
    reply({ jsonrpc: '2.0', id: request.id, result: { ok: true, ...result } });
  } catch (error) {
    if (error instanceof BizError) {
      reply({
        jsonrpc: '2.0',
        id: request.id,
        result: { ok: false, errorCode: error.errorCode, message: error.message, ...(error.detail ? { detail: error.detail } : {}) },
      });
    } else {
      log('unexpected error', request.method, error && error.stack ? error.stack : String(error));
      reply({
        jsonrpc: '2.0',
        id: request.id,
        result: { ok: false, errorCode: 'INTERNAL', message: `插件后台出错：${error && error.message ? error.message : String(error)}` },
      });
    }
  }
}

function start() {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!request || typeof request !== 'object') return;
    handle(request);
  });
}

// 本地单元测试时设置 ELYOFFICE_WORKER_TEST=1 只导入函数，不接管 stdin。
if (process.env.ELYOFFICE_WORKER_TEST !== '1') start();

module.exports = {
  verifyManifest,
  countOccurrences,
  countAll,
  cmpVersion,
  kindOf,
  normalizePath,
  requireAddress,
  expandAddresses,
  planTable,
  planCreate,
  resolveNewPath,
  withLoginName,
  launchCommand,
  METHODS,
};
