'use strict';
// 依据：ElyOffice 命令行打开文档后不能再加工作表、段落、幻灯片，create_document 必须在新建时
// 把这些结构写进文件。2026-11-24 已用 ElyOffice 0.1.17 实际打开这里生成的三种文件并读改通过；
// 这里锁定文件结构，防止改动后生成 ElyOffice 读不全的文件。
process.env.ELYOFFICE_WORKER_TEST = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const ooxml = require('../node/ooxml.cjs');
const { planCreate } = require('../node/worker.cjs');

const parts = (buffer) => new Map(ooxml.readZip(buffer).map((e) => [e.name, e.data.toString('utf8')]));
const ABS = process.platform === 'win32' ? 'C:\\docs\\' : '/docs/';

test('writes zip entries that read back byte for byte, content types first', () => {
  assert.equal(ooxml.crc32(Buffer.from('123456789')), 0xcbf43926);
  const data = Buffer.from('中文 & <xml>'.repeat(50));
  const zip = ooxml.writeZip([{ name: 'a/b.xml', data }, { name: '[Content_Types].xml', data: Buffer.from('t') }]);
  const back = ooxml.readZip(zip);
  assert.equal(back[0].name, '[Content_Types].xml');
  assert.ok(back[1].data.equals(data));
});

test('creates a workbook with every requested sheet', () => {
  const { buffer, sheets } = ooxml.buildXlsx(['概览', 'R&D', '收支明细']);
  assert.deepEqual(sheets, ['概览', 'R&D', '收支明细']);
  const files = parts(buffer);
  const names = [...files.get('xl/workbook.xml').matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"[^>]*r:id="([^"]+)"/g)];
  assert.deepEqual(names.map((m) => m[1]), ['概览', 'R&amp;D', '收支明细']);
  for (const [, , , rid] of names) {
    const target = files.get('xl/_rels/workbook.xml.rels').match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`))[1];
    assert.ok(files.has(`xl/${target}`), `${target} exists`);
    assert.match(files.get('[Content_Types].xml'), new RegExp(`PartName="/xl/${target}"`));
  }
  assert.deepEqual(ooxml.buildXlsx().sheets, ['Sheet1']);
});

test('rejects sheet names Excel would refuse', () => {
  for (const bad of [[], [''], ['a/b'], ['x'.repeat(32)], ['表', '表'], ["'q'"]]) {
    assert.throws(() => ooxml.buildXlsx(bad), ooxml.InputError, JSON.stringify(bad));
  }
});

test('creates a Word document with styled paragraphs on the regional paper size', () => {
  const cn = parts(ooxml.buildDocx([{ text: '预算说明', style: 'title' }, { text: '一、概况', style: 'heading1' }, '收入 & 支出\n结余 <10088.5>'], 'CN').buffer);
  const doc = cn.get('word/document.xml');
  const paras = [...doc.matchAll(/<w:pStyle w:val="([^"]+)"\/><\/w:pPr>(?:<w:r><w:t xml:space="preserve">([^<]*)<\/w:t><\/w:r>)?/g)];
  assert.deepEqual(paras.map((m) => [m[1], m[2]]), [
    ['Title', '预算说明'], ['Heading1', '一、概况'], ['BodyText', '收入 &amp; 支出'], ['BodyText', '结余 &lt;10088.5&gt;'],
  ]);
  assert.match(doc, /<w:pgSz w:w="11906" w:h="16838"\/>/, 'A4');
  assert.match(cn.get('word/styles.xml'), /w:styleId="Heading1"[\s\S]*<w:outlineLvl w:val="0"\/>/);
  const us = parts(ooxml.buildDocx(['x'], 'US').buffer).get('word/document.xml');
  assert.match(us, /<w:pgSz w:w="12240" w:h="15840"\/>/, 'Letter');
  assert.throws(() => ooxml.buildDocx([{ text: 'x', style: 'bold' }]), ooxml.InputError);
});

test('creates a deck with one slide per entry, a centered cover and left-aligned content', () => {
  const files = parts(ooxml.buildPptx([
    { title: '11 月预算回顾', text: '家庭财务小结' },
    { title: '收支概况', text: '收入 16200 元\n支出 6111.5 元' },
  ]).buffer);
  const ids = [...files.get('ppt/presentation.xml').matchAll(/<p:sldId id="(\d+)" r:id="([^"]+)"\/>/g)];
  assert.deepEqual(ids.map((m) => m[1]), ['256', '257']);
  for (const [, , rid] of ids) {
    const target = files.get('ppt/_rels/presentation.xml.rels').match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`))[1];
    assert.ok(files.has(`ppt/${target}`), `${target} exists`);
    assert.ok(files.has(`ppt/slides/_rels/${path.posix.basename(target)}.rels`));
  }
  const cover = files.get('ppt/slides/slide1.xml');
  assert.deepEqual([...cover.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]), ['11 月预算回顾', '家庭财务小结']);
  assert.doesNotMatch(cover, /algn="l"/);
  const content = files.get('ppt/slides/slide2.xml');
  assert.deepEqual([...content.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]), ['收支概况', '收入 16200 元', '支出 6111.5 元']);
  assert.match(content, /algn="l"/);
  assert.match(content, /anchor="t"/);
  assert.throws(() => ooxml.buildPptx([{ title: 'a\nb' }]), ooxml.InputError);
});

test('plans a new file only for supported types and matching content', () => {
  const xlsx = planCreate({ path: `${ABS}预算.xlsx`, sheets: ['概览'] });
  assert.equal(xlsx.kind, 'excel');
  assert.deepEqual(xlsx.info.sheets, ['概览']);
  assert.equal(planCreate({ path: `${ABS}笔记.md`, text: '# 标题' }).buffer.toString('utf8'), '# 标题');
  const bare = planCreate({ path: '会议纪要.docx', paragraphs: ['a'] });
  assert.ok(bare.target.startsWith(os.homedir()), 'a bare file name goes under the user folder');
  const code = (fn) => { try { fn(); } catch (e) { return e.errorCode; } return 'OK'; };
  assert.equal(code(() => planCreate({ path: `${ABS}a.txt` })), 'UNSUPPORTED_FILE_TYPE');
  assert.equal(code(() => planCreate({ path: 'sub/a.docx' })), 'INVALID_PATH');
  assert.equal(code(() => planCreate({ path: `${ABS}a.docx`, sheets: ['x'] })), 'INVALID_ARGS');
  assert.equal(code(() => planCreate({ path: `${ABS}a.xlsx`, sheets: ['a:b'] })), 'INVALID_ARGS');
  const template = path.join(__dirname, '..', 'templates', 'new.xlsx');
  assert.equal(planCreate({ path: `${ABS}副本.xlsx`, from: template }).from, template);
  assert.equal(code(() => planCreate({ path: `${ABS}副本.docx`, from: template })), 'INVALID_ARGS');
  assert.equal(code(() => planCreate({ path: `${ABS}副本.xlsx`, from: template, sheets: ['x'] })), 'INVALID_ARGS');
});
