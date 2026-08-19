// Structured inventory of the tutorial and getting-started prose, parsed from
// the same Sphinx _sources tree as the class reference.
//
// A tutorial's unit of "action" is its section heading: "Using the Import dock",
// "Baking lightmaps", "Creating a TileSet". Headings are what the sweep is
// exhaustive over -- every in-scope page contributes every heading it has -- so
// coverage can be claimed page by page rather than sampled.

import fs from "node:fs";
import path from "node:path";

export interface SectionRecord {
  /** Docs-relative page id, for example tutorials/2d/using_tilemaps. */
  page: string;
  /** Top-level docs area, for example tutorials/2d. */
  area: string;
  title: string;
  /** 1 for the page title, 2 for its sections, and so on. */
  level: number;
  /** First paragraph under the heading, enough to tier an ambiguous title. */
  lead: string;
}

const UNDERLINE = /^([=\-~^"'`#*+_])\1{2,}\s*$/;
const LEVEL_ORDER = ["=", "-", "~", "^", '"', "'", "`", "#", "*", "+", "_"];

/** Directives, comments, and markup lines that are never prose. */
function isMarkup(line: string): boolean {
  return line.startsWith(".. ") || line.startsWith(":") || line.trim() === "";
}

function stripInline(text: string): string {
  return text
    .replace(/:ref:`([^<`]*)<[^>]*>`/g, "$1")
    .replace(/:doc:`([^<`]*)<[^>]*>`/g, "$1")
    .replace(/``([^`]*)``/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\\/g, "")
    .trim();
}

function parsePage(file: string, page: string, area: string): SectionRecord[] {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const sections: SectionRecord[] = [];
  const seenLevels: string[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const underline = lines[index] ?? "";
    const title = lines[index - 1] ?? "";
    if (!UNDERLINE.test(underline)) continue;
    if (title.trim().length === 0 || isMarkup(title)) continue;
    // A heading's underline must be at least as long as the text it underlines.
    if (underline.trim().length < title.trim().length) continue;

    const marker = underline.trim()[0] as string;
    if (!seenLevels.includes(marker)) seenLevels.push(marker);
    // Level is the order of first appearance in this page, which is how RST
    // defines it, falling back to the conventional order for stability.
    const level = seenLevels.indexOf(marker) + 1 || LEVEL_ORDER.indexOf(marker) + 1;

    const lead: string[] = [];
    for (let scan = index + 1; scan < lines.length && lead.length < 3; scan += 1) {
      const line = lines[scan] ?? "";
      if (UNDERLINE.test(line)) break;
      if (isMarkup(line)) {
        if (lead.length > 0) break;
        continue;
      }
      lead.push(line.trim());
    }

    sections.push({ page, area, title: stripInline(title), level, lead: stripInline(lead.join(" ")).slice(0, 400) });
  }
  return sections;
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.name.endsWith(".rst.txt")) out.push(full);
  }
}

export function extractSections(root: string, areas: string[] = ["tutorials", "getting_started"]): SectionRecord[] {
  const sources = path.join(root, "_sources");
  const files: string[] = [];
  for (const area of areas) {
    const dir = path.join(sources, area);
    if (fs.existsSync(dir)) walk(dir, sources, files);
  }
  const records: SectionRecord[] = [];
  for (const file of files.sort()) {
    const rel = path.relative(sources, file).split(path.sep).join("/").replace(/\.rst\.txt$/, "");
    const parts = rel.split("/");
    const area = parts.length > 1 ? `${parts[0]}/${parts[1]}` : (parts[0] as string);
    records.push(...parsePage(file, rel, area));
  }
  return records;
}

if (import.meta.main) {
  const { resolveDocsRoot } = await import("./docs-root.ts");
  const root = resolveDocsRoot();
  const sections = extractSections(root);
  const byArea: Record<string, number> = {};
  for (const section of sections) byArea[section.area] = (byArea[section.area] ?? 0) + 1;
  const pages = new Set(sections.map((section) => section.page));
  console.log(JSON.stringify({ pages: pages.size, sections: sections.length, byArea }, null, 2));
}
