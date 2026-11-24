'use strict';
/**
 * 新建 Word / Excel / PPT 文件：以 ElyOffice 自带的空白文件（templates/，来源见 templates/README.md）
 * 为底，按 AI 给的工作表名、段落、幻灯片填好初始内容。只用 Node 自带模块，不引第三方依赖。
 *
 * ElyOffice 命令行只能改已有的文字和单元格，不能加段落、幻灯片或工作表，
 * 所以这些结构要在新建时一次写进文件。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');

// ───────────────────────── zip ─────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 读 zip（只支持 Office 文件用到的不压缩 / deflate 两种方式），返回 [{ name, data }]，保持原顺序。 */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip compression ${method}`);
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** 写 zip。[Content_Types].xml 放第一个，符合 Office 文件的惯例。 */
function writeZip(entries, now = new Date()) {
  const ordered = entries.slice().sort((a, b) => (a.name === '[Content_Types].xml' ? -1 : b.name === '[Content_Types].xml' ? 1 : 0));
  const { time, day } = dosDateTime(now);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of ordered) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const compressed = deflated.length < data.length;
    const body = compressed ? deflated : data;
    const method = compressed ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// ───────────────────────── 通用 ─────────────────────────

class InputError extends Error {}

function xmlText(value) {
  return String(value)
    // XML 1.0 不允许的控制字符直接去掉，免得文件打不开。
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadTemplate(name) {
  return new Map(readZip(fs.readFileSync(path.join(TEMPLATE_DIR, name))).map((e) => [e.name, e.data]));
}

function text(files, name) {
  const data = files.get(name);
  if (!data) throw new Error(`template part missing: ${name}`);
  return data.toString('utf8');
}

/** 模板里应有的标记没找到时立即失败，不生成残缺文件。 */
function replaceOnce(source, pattern, replacement, what) {
  if (!(typeof pattern === 'string' ? source.includes(pattern) : pattern.test(source))) {
    throw new Error(`template changed: ${what}`);
  }
  return source.replace(pattern, replacement);
}

function toZip(files) {
  return writeZip([...files].map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })));
}

// ───────────────────────── Excel ─────────────────────────

const SHEET_NAME_BAD = /[\\/?*[\]:]/;

function checkSheetNames(sheets) {
  if (sheets === undefined || sheets === null) return ['Sheet1'];
  if (!Array.isArray(sheets) || sheets.length === 0) throw new InputError('sheets 要是至少有一个工作表名的数组，如 ["概览","明细"]。');
  if (sheets.length > 50) throw new InputError('一次最多新建 50 张工作表。');
  const seen = new Set();
  return sheets.map((raw) => {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) throw new InputError('工作表名不能为空。');
    if (name.length > 31) throw new InputError(`工作表名「${name}」超过 31 个字符，Excel 不接受。`);
    if (SHEET_NAME_BAD.test(name) || /^'|'$/.test(name)) {
      throw new InputError(`工作表名「${name}」含有 Excel 不允许的字符（\\ / ? * [ ] : 或首尾单引号）。`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) throw new InputError(`工作表名「${name}」重复了。`);
    seen.add(key);
    return name;
  });
}

const WORKSHEET_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const WORKSHEET_CONTENT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

function buildXlsx(sheets) {
  const names = checkSheetNames(sheets);
  const files = loadTemplate('new.xlsx');
  const sheetXml = text(files, 'xl/worksheets/sheet1.xml');
  let workbook = text(files, 'xl/workbook.xml');
  let rels = text(files, 'xl/_rels/workbook.xml.rels');
  let types = text(files, '[Content_Types].xml');
  const firstSheet = workbook.match(/<sheet [^>]*r:id="([^"]+)"[^>]*\/>/);
  if (!firstSheet) throw new Error('template changed: workbook sheets');
  const entries = names.map((name, i) => {
    const rid = i === 0 ? firstSheet[1] : `rIdElySheet${i + 1}`;
    return `<sheet name="${xmlText(name)}" sheetId="${i + 1}" state="visible" r:id="${rid}"/>`;
  });
  workbook = replaceOnce(workbook, /<sheets>[\s\S]*?<\/sheets>/, `<sheets>${entries.join('')}</sheets>`, 'workbook sheets');
  for (let i = 1; i < names.length; i += 1) {
    const part = `worksheets/sheet${i + 1}.xml`;
    files.set(`xl/${part}`, sheetXml.replace('tabSelected="true"', 'tabSelected="false"'));
    rels = replaceOnce(rels, '</Relationships>', `<Relationship Id="rIdElySheet${i + 1}" Type="${WORKSHEET_TYPE}" Target="${part}"/></Relationships>`, 'workbook rels');
    types = replaceOnce(types, '</Types>', `<Override PartName="/xl/${part}" ContentType="${WORKSHEET_CONTENT}"/></Types>`, 'content types');
  }
  files.set('xl/workbook.xml', workbook);
  files.set('xl/_rels/workbook.xml.rels', rels);
  files.set('[Content_Types].xml', types);
  return { buffer: toZip(files), sheets: names };
}

// ───────────────────────── Word ─────────────────────────

const PARAGRAPH_STYLES = {
  title: 'Title',
  heading1: 'Heading1',
  heading2: 'Heading2',
  heading3: 'Heading3',
  normal: 'BodyText',
};

// 模板只有 LibreOffice 的通用 Heading 样式；补上 Word 认得的标题样式，标题能进导航和目录。
const EXTRA_STYLES = [
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Heading"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>',
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Heading"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>',
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>',
  '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Heading"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>',
].join('');

// 与 ElyDoc「默认纸张：随系统地区」一致：这些地区用 Letter，其余用 A4。
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'PR', 'CR', 'GT', 'PA', 'SV', 'DO', 'NI']);

function systemRegion() {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const m = locale.match(/[-_]([A-Za-z]{2})\b/);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

function checkParagraphs(paragraphs) {
  if (paragraphs === undefined || paragraphs === null) return [];
  if (!Array.isArray(paragraphs)) throw new InputError('paragraphs 要是数组：每项是一段文字，或 { text, style }。');
  const out = [];
  let total = 0;
  for (const item of paragraphs) {
    const p = typeof item === 'string' ? { text: item, style: 'normal' } : item;
    if (!p || typeof p.text !== 'string') throw new InputError('paragraphs 的每项要是文字，或带 text 的 { text, style }。');
    const style = p.style === undefined ? 'normal' : p.style;
    if (!Object.prototype.hasOwnProperty.call(PARAGRAPH_STYLES, style)) {
      throw new InputError(`段落样式「${style}」不支持，可用 title、heading1、heading2、heading3、normal。`);
    }
    // 一段里有换行就拆成几段：ElyOffice 的替换不跨段，按段落存最方便后续修改。
    for (const line of p.text.split(/\r?\n/)) {
      total += line.length;
      out.push({ text: line, style });
    }
  }
  if (out.length > 5000) throw new InputError('段落太多了（超过 5000 段），请分几份文档。');
  if (total > 500000) throw new InputError('文字太多了（超过 50 万字），请分几份文档。');
  return out;
}

function buildDocx(paragraphs, region = systemRegion()) {
  const list = checkParagraphs(paragraphs);
  const files = loadTemplate('new.docx');
  let doc = text(files, 'word/document.xml');
  let styles = text(files, 'word/styles.xml');
  const sect = doc.match(/<w:sectPr>[\s\S]*?<\/w:sectPr>/);
  if (!sect) throw new Error('template changed: sectPr');
  let sectPr = sect[0];
  if (!LETTER_REGIONS.has(region || '')) {
    sectPr = replaceOnce(sectPr, /<w:pgSz [^>]*\/>/, '<w:pgSz w:w="11906" w:h="16838"/>', 'page size');
  }
  const body = list.length
    ? list.map((p) => {
      const run = p.text ? `<w:r><w:t xml:space="preserve">${xmlText(p.text)}</w:t></w:r>` : '';
      return `<w:p><w:pPr><w:pStyle w:val="${PARAGRAPH_STYLES[p.style]}"/></w:pPr>${run}</w:p>`;
    }).join('')
    : '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p>';
  doc = replaceOnce(doc, /<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}${sectPr}</w:body>`, 'document body');
  styles = replaceOnce(styles, '</w:styles>', `${EXTRA_STYLES}</w:styles>`, 'styles');
  files.set('word/document.xml', doc);
  files.set('word/styles.xml', styles);
  return { buffer: toZip(files), paragraphs: list.length };
}

// ───────────────────────── PPT ─────────────────────────

const SLIDE_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const SLIDE_CONTENT = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

function checkSlides(slides) {
  if (slides === undefined || slides === null) return [{ title: '', text: '' }];
  if (!Array.isArray(slides) || slides.length === 0) throw new InputError('slides 要是至少有一页的数组：每页 { title, text }。');
  if (slides.length > 200) throw new InputError('一次最多新建 200 页幻灯片。');
  let total = 0;
  return slides.map((s) => {
    if (!s || typeof s !== 'object') throw new InputError('slides 的每页要是 { title, text }。');
    const title = s.title === undefined ? '' : s.title;
    const body = s.text === undefined ? '' : s.text;
    if (typeof title !== 'string' || typeof body !== 'string') throw new InputError('幻灯片的 title 和 text 要是文字。');
    if (/[\r\n]/.test(title)) throw new InputError('幻灯片标题不能换行。');
    total += title.length + body.length;
    if (total > 200000) throw new InputError('幻灯片文字太多了（超过 20 万字），请分几份演示文稿。');
    return { title, text: body };
  });
}

/** 把某个占位框里的空段落换成给定的几行文字；content 为 true 时改成左对齐、靠上的正文排版。 */
function fillPlaceholder(slideXml, phType, lines, { size, left, top }) {
  const re = new RegExp(`(<p:sp>(?:(?!</p:sp>)[\\s\\S])*?<p:ph type="${phType}"/>[\\s\\S]*?<p:txBody>)([\\s\\S]*?)(</p:txBody>)`);
  const m = slideXml.match(re);
  if (!m) throw new Error(`template changed: ${phType} placeholder`);
  let txBody = m[2];
  const para = txBody.match(/<a:p>([\s\S]*?)<\/a:p>/);
  if (!para) throw new Error(`template changed: ${phType} paragraph`);
  let pPr = (para[1].match(/<a:pPr[\s\S]*?<\/a:pPr>/) || [''])[0];
  let endRPr = (para[1].match(/<a:endParaRPr[\s\S]*?<\/a:endParaRPr>/) || [''])[0];
  if (!pPr || !endRPr) throw new Error(`template changed: ${phType} paragraph properties`);
  if (left) pPr = pPr.replace('algn="ctr"', 'algn="l"');
  if (size) endRPr = endRPr.replace(/sz="\d+"/, `sz="${size}"`);
  if (top) txBody = txBody.replace(/(<a:bodyPr[^>]*?)anchor="ctr"/, '$1anchor="t"');
  const rPr = endRPr.replace('<a:endParaRPr', '<a:rPr').replace('</a:endParaRPr>', '</a:rPr>');
  const paras = (lines.length ? lines : ['']).map((line) => (line
    ? `<a:p>${pPr}<a:r>${rPr}<a:t>${xmlText(line)}</a:t></a:r>${endRPr}</a:p>`
    : `<a:p>${pPr}${endRPr}</a:p>`)).join('');
  txBody = txBody.replace(/<a:p>[\s\S]*<\/a:p>/, paras);
  return slideXml.replace(re, `$1${txBody}$3`);
}

function buildPptx(slides) {
  const list = checkSlides(slides);
  const files = loadTemplate('new.pptx');
  const base = text(files, 'ppt/slides/slide1.xml');
  const baseRels = text(files, 'ppt/slides/_rels/slide1.xml.rels');
  let pres = text(files, 'ppt/presentation.xml');
  let presRels = text(files, 'ppt/_rels/presentation.xml.rels');
  let types = text(files, '[Content_Types].xml');
  const firstId = pres.match(/<p:sldId id="(\d+)" r:id="([^"]+)"\/>/);
  if (!firstId) throw new Error('template changed: slide list');
  const ids = [];
  list.forEach((s, i) => {
    const cover = i === 0;
    let xml = fillPlaceholder(base, 'title', s.title ? [s.title] : [], cover ? {} : { size: 3600, left: true });
    xml = fillPlaceholder(xml, 'subTitle', s.text ? s.text.split(/\r?\n/) : [], cover ? {} : { size: 2400, left: true, top: true });
    const n = i + 1;
    files.set(`ppt/slides/slide${n}.xml`, xml);
    if (i > 0) {
      files.set(`ppt/slides/_rels/slide${n}.xml.rels`, baseRels);
      presRels = replaceOnce(presRels, '</Relationships>', `<Relationship Id="rIdElySlide${n}" Type="${SLIDE_TYPE}" Target="slides/slide${n}.xml"/></Relationships>`, 'presentation rels');
      types = replaceOnce(types, '</Types>', `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${SLIDE_CONTENT}"/></Types>`, 'content types');
    }
    ids.push(`<p:sldId id="${Number(firstId[1]) + i}" r:id="${i === 0 ? firstId[2] : `rIdElySlide${n}`}"/>`);
  });
  pres = replaceOnce(pres, /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${ids.join('')}</p:sldIdLst>`, 'slide list');
  files.set('ppt/presentation.xml', pres);
  files.set('ppt/_rels/presentation.xml.rels', presRels);
  files.set('[Content_Types].xml', types);
  return { buffer: toZip(files), slides: list.length };
}

// ───────────────────────── Markdown ─────────────────────────

function buildMarkdown(body) {
  if (body !== undefined && body !== null && typeof body !== 'string') throw new InputError('text 要是 Markdown 文字。');
  const value = body || '';
  if (value.length > 1000000) throw new InputError('Markdown 文字太多了（超过 100 万字）。');
  return { buffer: Buffer.from(value, 'utf8') };
}

module.exports = {
  InputError,
  readZip,
  writeZip,
  crc32,
  checkSheetNames,
  buildXlsx,
  buildDocx,
  buildPptx,
  buildMarkdown,
};
