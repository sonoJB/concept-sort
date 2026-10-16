import { strFromU8, unzipSync } from "fflate";

/**
 * Tiny reader for workbooks written by `buildXlsx` (inline strings + plain
 * numbers only). Used by tests and by the backup restore-verification script
 * to read matrices BACK OUT of a generated .xlsx and compare them with the
 * values regenerated from a restored database. Not a general xlsx parser.
 */
export type ReadSheet = { name: string; rows: (string | number | null)[][] };

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(bytes: Uint8Array): ReadSheet[] {
  const files = unzipSync(bytes);
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => unescapeXml(m[1]));

  return names.map((name, i) => {
    const xml = strFromU8(files[`xl/worksheets/sheet${i + 1}.xml`]);
    const rows: (string | number | null)[][] = [];
    for (const rowMatch of xml.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)) {
      const rowIdx = Number(rowMatch[1]) - 1;
      while (rows.length <= rowIdx) rows.push([]);
      const row = rows[rowIdx];
      for (const cell of rowMatch[2].matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = colIndex(cell[1]);
        const inner = cell[2];
        while (row.length <= col) row.push(null);
        if (inner === undefined) continue;
        const str = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        if (str) row[col] = unescapeXml(str[1]);
        else {
          const num = inner.match(/<v>([^<]*)<\/v>/);
          if (num) row[col] = Number(num[1]);
        }
      }
    }
    return { name, rows };
  });
}
