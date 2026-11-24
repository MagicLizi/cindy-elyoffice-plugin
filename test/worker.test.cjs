'use strict';
// 依据：插件安装前必须核对 ElyOffice 官方签名；夹具是 ElyOffice v0.1.17 发布页上的真实清单与签名。
process.env.ELYOFFICE_WORKER_TEST = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyManifest, countOccurrences, cmpVersion, requireAddress, kindOf } = require('../node/worker.cjs');

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
  assert.equal(kindOf('/a/b.pdf'), null);
});
