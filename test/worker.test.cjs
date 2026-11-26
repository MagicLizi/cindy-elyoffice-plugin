'use strict';
// 依据：插件安装前必须核对 ElyOffice 官方签名；夹具是 ElyOffice v0.1.17 发布页上的真实清单与签名。
process.env.ELYOFFICE_WORKER_TEST = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  verifyManifest, countOccurrences, countAll, cmpVersion, requireAddress, kindOf,
  withLoginName, launchCommand, expandAddresses, planTable, openTimeoutMessage,
  parseDocList, parseSavedPath, notRunning,
} = require('../node/worker.cjs');

const NAME = 'ely-office-windows-x86_64.json';
const manifest = fs.readFileSync(path.join(__dirname, 'fixtures', NAME), 'utf8');
const signature = fs.readFileSync(path.join(__dirname, 'fixtures', `${NAME}.sig`), 'utf8');

test('accepts the officially signed release manifest', () => {
  const r = verifyManifest({ name: NAME, manifest, signature, platformKey: 'windows-x86_64' });
  assert.equal(r.version, '0.1.17');
  assert.equal(r.assetName, 'ElyOffice-0.1.17-windows-x86_64-setup.exe');
  assert.match(r.url, /^https:\/\/github\.com\/ELY-Open-Source\/ElyOffice\/releases\/download\//);
  assert.equal(r.sha256, 'c2da2d2d2e24bc4f4609e9b06864a020cb163af519cf7c62eb1d17df6fa62bbd');
});

test('rejects a manifest whose content was changed', () => {
  assert.throws(
    () => verifyManifest({ name: NAME, manifest: manifest.replace('c2da2d2d', 'c2da2d2e'), signature, platformKey: 'windows-x86_64' }),
    (e) => e.errorCode === 'SIGNATURE_INVALID',
  );
});

test('rejects a valid signature presented under another file name', () => {
  // 文件名也在签名内容里，防止把别的平台的清单拿来冒充。
  assert.throws(
    () => verifyManifest({ name: 'ely-office-macos-aarch64.json', manifest, signature, platformKey: 'windows-x86_64' }),
    (e) => e.errorCode === 'SIGNATURE_INVALID',
  );
});

test('reports a platform missing from a valid manifest instead of downloading', () => {
  assert.throws(
    () => verifyManifest({ name: NAME, manifest, signature, platformKey: 'linux-x86_64' }),
    (e) => e.errorCode === 'UNSUPPORTED_PLATFORM',
  );
});

test('counts matches within a paragraph or slide only, like ElyOffice replace', () => {
  assert.equal(countOccurrences('TODO a TODO\nTODO', 'TODO'), 3);
  assert.equal(countOccurrences('TO\nDO', 'TODO'), 0);
  assert.equal(countOccurrences('第一页 TODO\f第二页 todo', 'TODO'), 1);
});

test('requires a sheet name in cell addresses', () => {
  assert.equal(requireAddress('Sheet1!B2'), 'Sheet1!B2');
  assert.equal(requireAddress("'My Sheet'!$B$2"), "'My Sheet'!$B$2");
  assert.throws(() => requireAddress('B2'), (e) => e.errorCode === 'INVALID_ADDRESS');
});

test('compares versions numerically and routes files by extension', () => {
  assert.equal(cmpVersion('0.1.10', '0.1.9'), 1);
  assert.equal(cmpVersion('0.1.17', '0.1.17'), 0);
  assert.equal(kindOf('C:/a/Report.DOCX'), 'word');
  assert.equal(kindOf('/a/b.xls'), 'excel');
  assert.equal(kindOf('/a/b.pptx'), 'ppt');
  assert.equal(kindOf('/a/Notes.MD'), 'markdown');
  assert.equal(kindOf('/a/b.pdf'), 'pdf');
  assert.equal(kindOf('/a/b.txt'), null);
});

// 依据：2026-11-24 实测，Cindy 给插件后台的环境变量白名单不含 USERNAME，插件拉起的
// ElyTable 报「no USERNAME: environment variable not found」后起不来，open_document 一直超时。
test('adds the login name ElyOffice needs to the trimmed plugin environment', () => {
  const user = () => ({ username: 'Lizi' });
  const win = withLoginName({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' }, 'win32', user);
  assert.equal(win.USERNAME, 'Lizi');
  assert.equal(win.PATH, 'C:\\Windows');
  assert.equal(withLoginName({ USERNAME: 'Other' }, 'win32', user).USERNAME, 'Other', 'keeps an existing value');
  const mac = withLoginName({}, 'darwin', user);
  assert.deepEqual([mac.USER, mac.LOGNAME], ['Lizi', 'Lizi']);
  const noUser = withLoginName({ PATH: 'x' }, 'win32', () => { throw new Error('no account'); });
  assert.deepEqual(noUser, { PATH: 'x' });
});

test('passes --new-window only to apps that have several windows', () => {
  const app = { launcher: 'D:\\Ely\\ely-table-start.exe', exe: 'D:\\Ely\\ely-table.exe' };
  // 实测：ElyOffice 的启动器把 --new-window 交给运行中的实例，日志为「new window true」。
  assert.deepEqual(launchCommand('excel', app, 'E:\\a.xlsx', { newWindow: true, platform: 'win32' }), {
    cmd: app.launcher, args: ['ely-table', 'ElyTable', '--new-window', 'E:\\a.xlsx'],
  });
  // 实测：ElyMark 只有一个窗口，带上这个参数后文件根本没有打开。
  const mark = { launcher: 'D:\\Ely\\ely-mark-start.exe', exe: 'D:\\Ely\\ely-mark.exe' };
  assert.deepEqual(launchCommand('markdown', mark, 'E:\\a.md', { newWindow: true, platform: 'win32' }).args, ['ely-mark', 'ElyMark', 'E:\\a.md']);
  const macApp = { appPath: '/Applications/ElyTable.app', exe: '/Applications/ElyTable.app/Contents/MacOS/ely-table' };
  assert.deepEqual(launchCommand('excel', macApp, '/a.xlsx', { platform: 'darwin' }), { cmd: '/usr/bin/open', args: ['-a', macApp.appPath, '/a.xlsx'] });
  assert.deepEqual(launchCommand('excel', macApp, '/a.xlsx', { newWindow: true, platform: 'darwin' }), { cmd: macApp.exe, args: ['--new-window', '/a.xlsx'] });
});

test('counts Markdown matches across lines, like ElyMark replace', () => {
  assert.equal(countAll('- a\n- b\n- a\n- b', '- a\n- b'), 2);
  assert.equal(countAll('aaaa', 'aa'), 2, 'non-overlapping');
  assert.equal(countAll('abc', 'x'), 0);
});

test('expands cell ranges row by row and enforces the per-call limit', () => {
  assert.deepEqual(expandAddresses(['支出预算!A1:B2', "'My Sheet'!$C$3"]), [
    '支出预算!A1', '支出预算!B1', '支出预算!A2', '支出预算!B2', "'My Sheet'!C3",
  ]);
  assert.deepEqual(expandAddresses(['S!B2:A1']), ['S!A1', 'S!B1', 'S!A2', 'S!B2'], 'reversed corners');
  assert.deepEqual(expandAddresses(['S!Z1:AB1']), ['S!Z1', 'S!AA1', 'S!AB1']);
  assert.throws(() => expandAddresses(['S!A1:Z20']), (e) => e.errorCode === 'INVALID_ARGS', '520 cells');
  assert.throws(() => expandAddresses(['A1:B2']), (e) => e.errorCode === 'INVALID_ADDRESS');
});

test('plans a table write from one anchor cell, skipping nulls', () => {
  const plan = planTable('支出预算!B2', [['分类', '预算'], ['餐饮', 2000, null, '=C3-B3'], [true]]);
  assert.equal(plan.range, '支出预算!B2:E4');
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.cells.map((c) => [c.address, c.value]), [
    ['支出预算!B2', '分类'], ['支出预算!C2', '预算'],
    ['支出预算!B3', '餐饮'], ['支出预算!C3', '2000'], ['支出预算!E3', '=C3-B3'],
    ['支出预算!B4', 'TRUE'],
  ]);
  assert.throws(() => planTable('S!A1:B2', [['x']]), (e) => e.errorCode === 'INVALID_ADDRESS');
  assert.throws(() => planTable('S!A1', [[null]]), (e) => e.errorCode === 'INVALID_ARGS');
  assert.throws(() => planTable('S!A1', [[{}]]), (e) => e.errorCode === 'INVALID_ARGS');
  const big = Array.from({ length: 26 }, () => Array.from({ length: 20 }, () => 1));
  assert.throws(() => planTable('S!A1', big), (e) => e.errorCode === 'INVALID_ARGS' && /520/.test(e.message));
});

// 依据：2026-11-24 在 XDMini（macOS 26.6）实测，ElyTable 冷启动打开「文稿」里的文件时卡在系统的文件夹访问弹窗上，
// 插件只能报 OPEN_TIMEOUT；用户点「允许」后文件随即载入。Mac 上的超时提示要把这一步告诉用户。
test('tells Mac users to allow folder access when opening times out', () => {
  const mac = openTimeoutMessage('excel', '/Users/a/Documents/预算.xlsx', 'darwin');
  assert.match(mac, /预算\.xlsx/);
  assert.match(mac, /macOS 会弹窗询问是否允许 ElyTable 访问/);
  assert.doesNotMatch(openTimeoutMessage('excel', 'C:\\a\\预算.xlsx', 'win32'), /macOS/);
});

// 依据：ElyOffice 0.1.17 的 docs 用换行拼接路径（crates/ely-office/src/remote.rs 的 files.join("\n")）；
// 主干提交 7e6264bb53（2026-11-25，尚未发版）改为 serde_json 输出 JSON 数组、save 输出 JSON 字符串、
// 没在运行时退出码 3。插件旧写法按行切分，新版会把整个数组当成一个路径，所有「文件是否已打开」都判错。
test('reads the open-file list from ElyOffice 0.1.17 and from the JSON format on its main branch', () => {
  assert.deepEqual(parseDocList('C:\\a\\周报.docx\r\nC:\\b c\\预算.xlsx\r\n'), ['C:\\a\\周报.docx', 'C:\\b c\\预算.xlsx']);
  assert.deepEqual(parseDocList(''), []);
  assert.deepEqual(
    parseDocList('["C:\\\\a\\\\周报.docx","/Users/a/第一行\\n第二行.docx"]\n'),
    ['C:\\a\\周报.docx', '/Users/a/第一行\n第二行.docx'],
  );
  assert.deepEqual(parseDocList('[]\n'), []);
});

test('reads the saved path in both the plain and the JSON format', () => {
  assert.equal(parseSavedPath('C:\\a\\周报.docx\r\n'), 'C:\\a\\周报.docx');
  assert.equal(parseSavedPath('"C:\\\\a\\\\周报.docx"\n'), 'C:\\a\\周报.docx');
});

test('treats exit code 3 as the app not running, as the newer command line reports it', () => {
  assert.equal(notRunning({ code: 3, stderr: 'ely-doc: ElyDoc is not running; use open FILE to start it\n' }), true);
  assert.equal(notRunning({ code: 3, stderr: '' }), true);
  assert.equal(notRunning({ code: 1, stderr: 'ely-doc: C:\\a.docx is not open in ElyDoc\n' }), false);
});
