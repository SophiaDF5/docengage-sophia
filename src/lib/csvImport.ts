import Papa from "papaparse";
import * as XLSX from "xlsx";

export interface ParsedLeadRow {
  full_name?: string;
  linkedin_profile_url: string;
}

function normalizeKey(key: string) {
  return key.trim().toLowerCase();
}

function extractRows(rows: Record<string, unknown>[]): ParsedLeadRow[] {
  return rows
    .map((row) => {
      let name: string | undefined;
      let url: string | undefined;

      for (const [key, value] of Object.entries(row)) {
        const k = normalizeKey(key);
        const v = typeof value === "string" ? value.trim() : String(value ?? "").trim();
        if (!v) continue;

        if (!url && (k.includes("linkedin") || k.includes("url") || k.includes("profile"))) {
          url = v;
        } else if (!name && k.includes("name")) {
          name = v;
        }
      }

      return { full_name: name, linkedin_profile_url: url };
    })
    .filter(
      (r): r is { full_name: string | undefined; linkedin_profile_url: string } =>
        !!r.linkedin_profile_url
    );
}

// Used by the Manual Added Leads page's CSV/Excel upload. Looks for columns
// with "linkedin"/"url"/"profile" and "name" in the header (case-insensitive,
// order-independent) rather than requiring exact column names.
export async function parseLeadFile(file: File): Promise<ParsedLeadRow[]> {
  const isCsv = file.name.toLowerCase().endsWith(".csv");

  if (isCsv) {
    const text = await file.text();
    const result = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    return extractRows(result.data);
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, { defval: "" });
  return extractRows(rows);
}
