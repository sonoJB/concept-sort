/** Shared CSV encode/decode helpers used by both admin exports and imports. */

export function toCsv(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

/** Prefixes a UTF-8 BOM so Excel opens Korean/Japanese text without mangling it. */
export function toCsvWithBom(rows: string[][]): string {
  return "﻿" + toCsv(rows);
}

export function downloadCsv(filename: string, content: string) {
  const blob = new Blob(["﻿" + content], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Minimal RFC4180 CSV parser: handles quoted fields, escaped quotes, CRLF/LF. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // swallow; \n (if present) closes the row on the next iteration
    } else {
      field += c;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Parses a CSV with a header row into an array of column->value objects. */
export function parseCsvRecords(input: string): Record<string, string>[] {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((row) => {
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      record[key.trim()] = row[i] ?? "";
    });
    return record;
  });
}
