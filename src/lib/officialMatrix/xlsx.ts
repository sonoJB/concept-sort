import { zipSync, strToU8 } from "fflate";

/**
 * Minimal, dependency-free .xlsx (Office Open XML) writer built on the
 * already-installed `fflate`. Only what the official-matrix and backup
 * workbooks need: multiple sheets, string / number cells, bold header cells,
 * column widths and a frozen header row/column.
 *
 * Every string is written as an inline string (`t="inlineStr"`), never as a
 * formula, so a participant-supplied value starting with `=`/`+`/`-`/`@` can
 * never be evaluated by Excel. Numeric-looking identifiers (e.g. a Japan
 * participant's "0123") must be passed as strings to keep their leading zero.
 */

export type XlsxCell = string | number | null | { v: string | number | null; bold?: boolean };

export type XlsxSheet = {
  name: string;
  rows: XlsxCell[][];
  /** Column widths in Excel character units, by column index. */
  colWidths?: number[];
  /** Freeze this many top rows / left columns (0 = none). */
  freeze?: { rows: number; cols: number };
};

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Characters that are illegal in XML 1.0 (control chars except tab/LF/CR, lone surrogates). */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function escapeXml(s: string): string {
  return s
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 -> A, 25 -> Z, 26 -> AA ... */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

const INVALID_SHEET_CHARS = /[\\/?*[\]:]/g;

export function sanitizeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(INVALID_SHEET_CHARS, "_").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `_${i++}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function cellXml(ref: string, cell: XlsxCell): string {
  const bold = typeof cell === "object" && cell !== null && cell.bold === true;
  const value = typeof cell === "object" && cell !== null ? cell.v : cell;
  const s = bold ? ' s="1"' : "";
  if (value === null || value === undefined || value === "") {
    return bold ? `<c r="${ref}"${s}/>` : "";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`xlsx: non-finite number at ${ref}`);
    }
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const parts: string[] = [XML_HEADER, '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];

  const freeze = sheet.freeze;
  if (freeze && (freeze.rows > 0 || freeze.cols > 0)) {
    const topLeft = `${columnLetter(freeze.cols)}${freeze.rows + 1}`;
    const pane =
      freeze.rows > 0 && freeze.cols > 0
        ? "bottomRight"
        : freeze.rows > 0
          ? "bottomLeft"
          : "topRight";
    const xs = freeze.cols > 0 ? ` xSplit="${freeze.cols}"` : "";
    const ys = freeze.rows > 0 ? ` ySplit="${freeze.rows}"` : "";
    parts.push(
      `<sheetViews><sheetView workbookViewId="0"><pane${xs}${ys} topLeftCell="${topLeft}" activePane="${pane}" state="frozen"/></sheetView></sheetViews>`
    );
  }

  if (sheet.colWidths && sheet.colWidths.length > 0) {
    parts.push("<cols>");
    sheet.colWidths.forEach((w, i) => {
      parts.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`);
    });
    parts.push("</cols>");
  }

  parts.push("<sheetData>");
  sheet.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((cell, c) => {
      const xml = cellXml(`${columnLetter(c)}${r + 1}`, cell);
      if (xml) cells.push(xml);
    });
    if (cells.length > 0) parts.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

const STYLES_XML =
  XML_HEADER +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** Builds a complete .xlsx file. Deterministic for identical input (fixed zip mtime). */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("xlsx: at least one sheet is required");

  const used = new Set<string>();
  const names = sheets.map((s) => sanitizeSheetName(s.name, used));

  const files: Record<string, Uint8Array> = {};
  files["[Content_Types].xml"] = strToU8(
    XML_HEADER +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join("") +
      "</Types>"
  );
  files["_rels/.rels"] = strToU8(
    XML_HEADER +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>"
  );
  files["xl/workbook.xml"] = strToU8(
    XML_HEADER +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<sheets>" +
      names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets></workbook>"
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    XML_HEADER +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
        )
        .join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      "</Relationships>"
  );
  files["xl/styles.xml"] = strToU8(STYLES_XML);
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet));
  });

  return zipSync(files, { level: 6, mtime: new Date(Date.UTC(2020, 0, 1)) });
}
