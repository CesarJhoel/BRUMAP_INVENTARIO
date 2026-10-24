// Exportador Open XML: solo escribe valores, nunca interpreta fórmulas o archivos externos.
import { deflateRawSync } from 'node:zlib';

const xml = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  .replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[character]));
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function createZip(files) {
  const parts = [], directory = [];
  let offset = 0;
  for (const [filename, content] of files) {
    const name = Buffer.from(filename), body = Buffer.from(content), compressed = deflateRawSync(body), checksum = crc32(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20,4); header.writeUInt16LE(8,8); header.writeUInt16LE(33,12);
    header.writeUInt32LE(checksum,14); header.writeUInt32LE(compressed.length,18); header.writeUInt32LE(body.length,22); header.writeUInt16LE(name.length,26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(8,10); central.writeUInt16LE(33,14);
    central.writeUInt32LE(checksum,16); central.writeUInt32LE(compressed.length,20); central.writeUInt32LE(body.length,24); central.writeUInt16LE(name.length,28); central.writeUInt32LE(offset,42);
    parts.push(header,name,compressed); directory.push(central,name);
    offset += header.length + name.length + compressed.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(index.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,index,end]);
}
function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}
export function createWorkbook(sheets) {
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relation = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    ['[Content_Types].xml', declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((_,index) => `<Override PartName="/xl/worksheets/sheet${index+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
    ['_rels/.rels', declaration + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relation}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', declaration + `<workbook xmlns="${namespace}" xmlns:r="${relation}"><sheets>${sheets.map((sheet,index) => `<sheet name="${xml(String(sheet.name||'Inventario').replace(/[\\/*?:\[\]]/g,' ').slice(0,31))}" sheetId="${index+1}" r:id="rId${index+1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', declaration + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,index) => `<Relationship Id="rId${index+1}" Type="${relation}/worksheet" Target="worksheets/sheet${index+1}.xml"/>`).join('')}</Relationships>`]
  ];
  sheets.forEach((sheet,index) => {
    const rows = sheet.aoa.map((row,rowIndex) => `<row r="${rowIndex+1}">${row.map((value,colIndex) => {
      const address = `${columnName(colIndex)}${rowIndex+1}`;
      return typeof value === 'number' && Number.isFinite(value) ? `<c r="${address}"><v>${value}</v></c>` : `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('')}</row>`).join('');
    files.push([`xl/worksheets/sheet${index+1}.xml`, declaration + `<worksheet xmlns="${namespace}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rows}</sheetData></worksheet>`]);
  });
  return createZip(files);
}
