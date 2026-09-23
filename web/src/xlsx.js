// 最小 XLSX（OOXML/ZIP）生成器 —— 零依赖，输出标准 .xlsx 文件：
// ZIP 容器（STORE 无压缩 + CRC32）+ 5 个 OOXML 部件，Excel / WPS / Numbers 均可直接打开。
// 仅用于体重记录导出，不做通用性扩展。

/* ---------- CRC32（ZIP 条目校验） ---------- */
let CRC_TABLE = null
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  CRC_TABLE = t
  return t
}
function crc32(buf) {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const te = new TextEncoder()

/* ---------- ZIP（仅 STORE，无压缩） ---------- */
// 组装一个 ZIP 文件：entries = [{ name, data: Uint8Array }] → Uint8Array
function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  const now = new Date()
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() >> 1) & 31)
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31)

  for (const e of entries) {
    const nameB = te.encode(e.name)
    const crc = crc32(e.data)

    // Local File Header
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true)
    lh.setUint16(4, 20, true)        // version needed
    lh.setUint16(6, 0x0800, true)    // flags: UTF-8
    lh.setUint16(8, 0, true)         // method: store
    lh.setUint16(10, dosTime, true)
    lh.setUint16(12, dosDate, true)
    lh.setUint32(14, crc, true)
    lh.setUint32(18, e.data.length, true)
    lh.setUint32(22, e.data.length, true)
    lh.setUint16(26, nameB.length, true)
    lh.setUint16(28, 0, true)        // extra len

    chunks.push(new Uint8Array(lh.buffer), nameB, e.data)
    central.push({ nameB, crc, size: e.data.length, offset, head: lh })
    offset += 30 + nameB.length + e.data.length
  }

  // Central Directory
  let cdStart = offset
  for (const c of central) {
    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true)        // version made by
    cd.setUint16(6, 20, true)        // version needed
    cd.setUint16(8, 0x0800, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, c.head.getUint16(10, true), true)
    cd.setUint16(14, c.head.getUint16(12, true), true)
    cd.setUint32(16, c.crc, true)
    cd.setUint32(20, c.size, true)
    cd.setUint32(24, c.size, true)
    cd.setUint16(28, c.nameB.length, true)
    cd.setUint16(30, 0, true)
    cd.setUint16(32, 0, true)
    cd.setUint16(34, 0, true)
    cd.setUint16(36, 0, true)
    cd.setUint32(38, 0, true)        // external attrs
    cd.setUint32(42, c.offset, true)
    chunks.push(new Uint8Array(cd.buffer), c.nameB)
    offset += 46 + c.nameB.length
  }

  // End Of Central Directory
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(4, 0, true)
  eocd.setUint16(6, 0, true)
  eocd.setUint16(8, central.length, true)
  eocd.setUint16(10, central.length, true)
  eocd.setUint32(12, offset - cdStart, true)
  eocd.setUint32(16, cdStart, true)
  eocd.setUint16(20, 0, true)
  chunks.push(new Uint8Array(eocd.buffer))

  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) { out.set(c, p); p += c.length }
  return out
}

/* ---------- OOXML 部件 ---------- */
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
function escXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
}

// 单 sheet 最小工作簿。rows: 数组，每项是单元格字符串数组（数值也按字符串写入，保证展示原值）
function buildWorkbookXml(sheetName) {
  return `${XML_DECL}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${escXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
}

function buildSheetXml(rows) {
  const colW = [14, 8, 10, 28]
  const cols = colW.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}"/>`).join('')
  const body = rows.map((row, ri) => {
    const rn = ri + 1
    const cells = row.map((val, ci) => {
      const ref = `${String.fromCharCode(65 + ci)}${rn}`
      // 数字（体重/时间等数值列）用数值单元格，其余用内联字符串
      if (typeof val === 'number' && isFinite(val)) {
        return `<c r="${ref}"><v>${val}</v></c>`
      }
      return `<c r="${ref}" t="inlineStr"><is><t>${escXml(val)}</t></is></c>`
    }).join('')
    return `<row r="${rn}">${cells}</row>`
  }).join('')
  return `${XML_DECL}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>${cols}</cols>
  <sheetData>${body}</sheetData>
</worksheet>`
}

/* ---------- 对外 API ---------- */
// headers/rows 都是字符串或数字的二维数组；返回 .xlsx 的 Uint8Array
export function buildXlsx({ sheetName = 'Sheet1', headers = [], rows = [] } = {}) {
  const all = [headers, ...rows].filter((r) => r.length)
  const text = (s) => te.encode(String(s))
  const entries = [
    { name: '[Content_Types].xml', data: text(`${XML_DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`) },
    { name: '_rels/.rels', data: text(`${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
    { name: 'xl/workbook.xml', data: text(buildWorkbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', data: text(`${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`) },
    { name: 'xl/worksheets/sheet1.xml', data: text(buildSheetXml(all)) }
  ]
  return buildZip(entries)
}