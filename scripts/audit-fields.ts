/*
 * Field audit — extracts every (index pattern, field, aggregation) tuple from
 * ES|QL queries in src/tools/, probes Elasticsearch for each field's mapping
 * and a few sample values, and writes FIELD-AUDIT.md flagging usages that
 * look wrong for the field's storage shape.
 *
 * Targeted at the OTel Astronomy Shop demo cluster as the canonical source of
 * truth — this is what most people who download the MCP app will test
 * against. If a second cluster is later probed and disagrees on a field's
 * type, the first response wins (authoritative) and the conflict is logged.
 *
 * Usage:
 *   ELASTICSEARCH_URL=... ELASTICSEARCH_API_KEY=... \
 *   npx tsx scripts/audit-fields.ts
 *
 * Optional flags:
 *   --out <path>   Override output path (default: FIELD-AUDIT.md)
 *   --no-samples   Skip sample-value probing (faster, mapping only)
 */

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { executeEsql, rowsFromEsql } from "../src/elastic/esql.js";
import { esRequest } from "../src/elastic/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, "..", "src", "tools");
const DEFAULT_OUT = join(__dirname, "..", "FIELD-AUDIT.md");

const AGG_FUNCS = [
  "AVG",
  "SUM",
  "MAX",
  "MIN",
  "COUNT",
  "COUNT_DISTINCT",
  "MEDIAN",
  "PERCENTILE",
  "VALUES",
  "TOP",
];

interface Usage {
  tool: string;
  indexPatterns: string[];
  field: string;
  aggregation: string;
  hasTimeFilter: boolean;
  queryExcerpt: string;
}

interface FieldMeta {
  esType: string | null;
  metricType: string | null; // gauge | counter | histogram | null
  defaultMetric: string | null; // for aggregate_metric_double
  sampleValues: unknown[];
  resolvedIndex: string | null; // concrete index used to resolve
  notes: string[];
}

type Verdict = "OK" | "CHECK" | "SUSPECT" | "WRONG" | "UNKNOWN";

interface AuditRow {
  usage: Usage;
  meta: FieldMeta | null;
  verdict: Verdict;
  rationale: string;
}

// ——— Extraction ————————————————————————————————————————————————————————————

// Extract only *template literals* (backtick strings) from TypeScript source,
// ignoring backticks that appear inside regular single- / double-quoted strings
// or line / block comments. This is a scan-based implementation — not a real
// parser — but handles the shapes we produce in this codebase.
function extractBacktickStrings(src: string): string[] {
  type State = "code" | "sq" | "dq" | "tpl" | "line" | "block";
  const out: string[] = [];
  let state: State = "code";
  let tplStart = -1;
  let tplDepth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    switch (state) {
      case "code":
        if (c === "/" && next === "/") { state = "line"; i++; break; }
        if (c === "/" && next === "*") { state = "block"; i++; break; }
        if (c === "'") { state = "sq"; break; }
        if (c === '"') { state = "dq"; break; }
        if (c === "`") { state = "tpl"; tplStart = i + 1; break; }
        break;
      case "line":
        if (c === "\n") state = "code";
        break;
      case "block":
        if (c === "*" && next === "/") { state = "code"; i++; }
        break;
      case "sq":
        if (c === "\\") { i++; break; }
        if (c === "'") state = "code";
        break;
      case "dq":
        if (c === "\\") { i++; break; }
        if (c === '"') state = "code";
        break;
      case "tpl":
        if (c === "\\") { i++; break; }
        if (c === "$" && next === "{") { tplDepth++; i++; break; }
        if (tplDepth > 0 && c === "}") { tplDepth--; break; }
        if (tplDepth === 0 && c === "`") {
          out.push(src.slice(tplStart, i));
          state = "code";
        }
        break;
    }
  }
  return out;
}

function isEsqlQuery(s: string): boolean {
  // Real queries start with `FROM <index>` at the top (possibly after
  // whitespace). Prose examples inside tool descriptions tend to embed the
  // query inside wider text ("e.g. `FROM ... | STATS ...`") — and when the
  // template literal concatenates with prior strings, the FROM won't be at
  // the start. This filter keeps only the executable queries.
  if (!/^\s*FROM\s+[a-zA-Z]/.test(s)) return false;
  return /\|\s*STATS\b/.test(s) || /\|\s*WHERE\b/.test(s) || /\|\s*KEEP\b/.test(s);
}

function stripInterpolations(s: string): string {
  return s.replace(/\$\{[^}]*\}/g, "<EXPR>");
}

function extractIndexPatterns(query: string): string[] {
  const m = query.match(/FROM\s+([^\n|]+)/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasTimestampFilter(query: string): boolean {
  return /WHERE[^|]*@timestamp\s*>/i.test(query);
}

// Columns introduced by `EVAL name = ...` or `STATS name = AGG(...)` are
// intermediate results within the query — not source fields. We skip them so
// the audit only examines fields that originate from the index mapping.
function extractLocalColumns(query: string): Set<string> {
  const locals = new Set<string>();
  const identRe = /([a-zA-Z_][a-zA-Z0-9_.]*)\s*=/g;
  // Split on pipe stages and only inspect EVAL / STATS clauses so we don't
  // accidentally pick up `WHERE foo = 1` comparisons.
  for (const stage of query.split("|")) {
    const trimmed = stage.trim();
    if (!/^(EVAL|STATS)\b/i.test(trimmed)) continue;
    let m: RegExpExecArray | null;
    while ((m = identRe.exec(trimmed)) !== null) {
      locals.add(m[1]);
    }
    identRe.lastIndex = 0;
  }
  return locals;
}

function extractUsages(tool: string, query: string): Usage[] {
  const stripped = stripInterpolations(query);
  const indexPatterns = extractIndexPatterns(stripped);
  const hasTime = hasTimestampFilter(stripped);
  const locals = extractLocalColumns(stripped);

  const usages: Usage[] = [];
  const seen = new Set<string>();
  const aggRegex = new RegExp(
    `\\b(${AGG_FUNCS.join("|")})\\s*\\(\\s*([a-zA-Z_][a-zA-Z0-9_.]*)\\s*\\)`,
    "g"
  );

  let m: RegExpExecArray | null;
  while ((m = aggRegex.exec(stripped)) !== null) {
    const agg = m[1].toUpperCase();
    const field = m[2];
    if (field === "EXPR") continue;
    if (locals.has(field)) continue; // intermediate column, not a source field
    const key = `${agg}|${field}`;
    if (seen.has(key)) continue;
    seen.add(key);

    usages.push({
      tool,
      indexPatterns,
      field,
      aggregation: agg,
      hasTimeFilter: hasTime,
      queryExcerpt: stripped.trim().slice(0, 240).replace(/\s+/g, " "),
    });
  }
  return usages;
}

function loadAllUsages(): Usage[] {
  const usages: Usage[] = [];
  for (const file of readdirSync(TOOLS_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const tool = basename(file, ".ts");
    const src = readFileSync(join(TOOLS_DIR, file), "utf8");
    const queries = extractBacktickStrings(src).filter(isEsqlQuery);
    for (const q of queries) {
      usages.push(...extractUsages(tool, q));
    }
  }
  return usages;
}

// ——— Mapping probe ————————————————————————————————————————————————————————————
//
// Uses _field_caps instead of _mapping. _field_caps is supported on serverless
// and returns the merged view of field types across a pattern (with each type
// represented once). _mapping/field returns 410 on serverless projects.

interface FieldCapsResponse {
  indices: string[];
  fields: {
    [fieldName: string]: {
      [esType: string]: {
        type: string;
        searchable?: boolean;
        aggregatable?: boolean;
        time_series_metric?: string;
        metric_type?: string;
        default_metric?: string;
        meta?: Record<string, unknown>;
        indices?: string[];
      };
    };
  };
}

const fieldCapsCache = new Map<string, FieldCapsResponse | null>();

async function getFieldCaps(
  pattern: string,
  field: string
): Promise<FieldCapsResponse | null> {
  const key = `${pattern}|${field}`;
  if (fieldCapsCache.has(key)) return fieldCapsCache.get(key)!;
  try {
    const res = await esRequest<FieldCapsResponse>(
      `/${encodeURIComponent(pattern)}/_field_caps`,
      {
        params: {
          fields: field,
          allow_no_indices: "true",
          ignore_unavailable: "true",
        },
      }
    );
    fieldCapsCache.set(key, res);
    return res;
  } catch (err) {
    process.stderr.write(
      `[audit] field_caps fetch failed for ${pattern} (${field}): ${(err as Error).message}\n`
    );
    fieldCapsCache.set(key, null);
    return null;
  }
}

async function resolveFieldMeta(
  indexPatterns: string[],
  field: string
): Promise<FieldMeta> {
  const notes: string[] = [];
  let authoritative: {
    type: string;
    metricType: string | null;
    defaultMetric: string | null;
    pattern: string;
  } | null = null;

  for (const pattern of indexPatterns) {
    const caps = await getFieldCaps(pattern, field);
    if (!caps) continue;
    const fieldEntry = caps.fields?.[field];
    if (!fieldEntry) continue;

    for (const [esType, meta] of Object.entries(fieldEntry)) {
      if (esType === "unmapped" || esType === "object" || esType === "nested") continue;
      const metricType = meta.time_series_metric ?? meta.metric_type ?? null;
      const defaultMetric = meta.default_metric ?? null;
      if (!authoritative) {
        authoritative = { type: esType, metricType, defaultMetric, pattern };
      } else if (authoritative.type !== esType) {
        notes.push(
          `conflict: ${pattern} reports type '${esType}' but authoritative (${authoritative.pattern}) is '${authoritative.type}'`
        );
      }
    }
  }

  if (!authoritative) {
    return {
      esType: null,
      metricType: null,
      defaultMetric: null,
      sampleValues: [],
      resolvedIndex: null,
      notes: ["field not present in field_caps for any probed pattern"],
    };
  }

  return {
    esType: authoritative.type,
    metricType: authoritative.metricType,
    defaultMetric: authoritative.defaultMetric,
    sampleValues: [],
    resolvedIndex: authoritative.pattern,
    notes,
  };
}

async function fetchSamples(
  indexPatterns: string[],
  field: string,
  maxRows = 3
): Promise<unknown[]> {
  for (const pattern of indexPatterns) {
    const query = `FROM ${pattern} | WHERE ${field} IS NOT NULL | KEEP ${field} | LIMIT ${maxRows}`;
    try {
      const res = await executeEsql(query);
      const rows = rowsFromEsql<Record<string, unknown>>(res);
      if (rows.length) return rows.map((r) => r[field]);
    } catch {
      // try next pattern
    }
  }
  return [];
}

// ——— Verdicts ————————————————————————————————————————————————————————————

function verdictFor(usage: Usage, meta: FieldMeta | null): { v: Verdict; r: string } {
  if (!meta || !meta.esType) {
    return { v: "UNKNOWN", r: "field not found in mapping; query may match no docs or field may be dynamically created only in some clusters" };
  }

  const { aggregation: agg } = usage;
  const { esType, metricType } = meta;

  if (esType === "aggregate_metric_double") {
    if (agg === "AVG") {
      return {
        v: "SUSPECT",
        r: "AVG on aggregate_metric_double can return sum-of-sums instead of a true mean depending on which components are present (sum/count/min/max). Use MAX for a peak-bound value, or compute sum/count explicitly.",
      };
    }
    if (agg === "SUM") {
      return {
        v: "SUSPECT",
        r: "SUM on aggregate_metric_double sums the pre-aggregated sum components across buckets — rarely semantically what you want for a gauge.",
      };
    }
    if (agg === "MAX" || agg === "MIN") {
      return { v: "OK", r: `${agg} on aggregate_metric_double returns ${agg.toLowerCase()}-of-${agg.toLowerCase()}es — tight bound.` };
    }
  }

  if (metricType === "counter") {
    if (agg === "AVG" || agg === "SUM") {
      return { v: "WRONG", r: `${agg} on a counter field is meaningless; counters are monotonically increasing. Rate-it via RATE() or compute delta via MAX - MIN per bucket.` };
    }
    if (agg === "MAX" || agg === "MIN") {
      return { v: "OK", r: `${agg} on a counter is valid for delta calculations.` };
    }
  }

  if (metricType === "gauge") {
    if (agg === "SUM" && !usage.hasTimeFilter) {
      return {
        v: "WRONG",
        r: "SUM on a gauge without a @timestamp filter multiplies the true value by the number of samples in the retention window. Add a bounded time filter or switch to AVG/MAX per entity first.",
      };
    }
    if (agg === "SUM") {
      return {
        v: "CHECK",
        r: "SUM on a gauge is only meaningful across entities (pods, hosts); within one entity's samples it multiplies by sample count. Confirm the grouping collapses samples first.",
      };
    }
  }

  if (esType === "histogram") {
    if (agg !== "COUNT") {
      return { v: "WRONG", r: `${agg} on a histogram field doesn't produce a scalar — use percentile helpers or PERCENTILE().` };
    }
  }

  return { v: "OK", r: `${agg} on ${esType}${metricType ? ` (${metricType})` : ""} — standard usage.` };
}

// ——— Report ————————————————————————————————————————————————————————————

function renderReport(rows: AuditRow[]): string {
  const now = new Date().toISOString();
  const lines: string[] = [];

  lines.push("# Field Audit");
  lines.push("");
  lines.push(`Generated: ${now}`);
  lines.push("");
  lines.push(
    "Every (field, aggregation) tuple extracted from ES|QL queries under `src/tools/`, probed against the live cluster's mapping. The audit is opinionated about which combinations are safe — `SUSPECT`/`WRONG` verdicts are the ones to look at first."
  );
  lines.push("");
  lines.push("Verdicts:");
  lines.push("");
  lines.push("- **OK** — standard, expected to work correctly.");
  lines.push("- **CHECK** — valid but context-dependent; confirm the grouping / filter makes the aggregation meaningful.");
  lines.push("- **SUSPECT** — behavior may differ from naive expectation (e.g. `AVG` on `aggregate_metric_double`).");
  lines.push("- **WRONG** — aggregation does not match the field's storage shape.");
  lines.push("- **UNKNOWN** — field not present in the probed cluster's mapping; can't assess.");
  lines.push("");

  const byVerdict: Record<Verdict, AuditRow[]> = {
    WRONG: [],
    SUSPECT: [],
    CHECK: [],
    UNKNOWN: [],
    OK: [],
  };
  for (const r of rows) byVerdict[r.verdict].push(r);

  for (const v of ["WRONG", "SUSPECT", "CHECK", "UNKNOWN", "OK"] as Verdict[]) {
    const list = byVerdict[v];
    if (!list.length) continue;
    lines.push(`## ${v} (${list.length})`);
    lines.push("");
    lines.push("| Tool | Field | Aggregation | ES type | Metric type | Index resolved from | Rationale |");
    lines.push("|------|-------|-------------|---------|-------------|---------------------|-----------|");
    for (const r of list) {
      const esType = r.meta?.esType ?? "—";
      const mt = r.meta?.metricType ?? "—";
      const idx = r.meta?.resolvedIndex ?? "—";
      const notes = r.meta?.notes.length ? ` *(${r.meta.notes.join("; ")})*` : "";
      lines.push(
        `| \`${r.usage.tool}\` | \`${r.usage.field}\` | \`${r.usage.aggregation}\` | \`${esType}\` | \`${mt}\` | \`${idx}\` | ${r.rationale}${notes} |`
      );
    }
    lines.push("");
  }

  // Appendix: samples
  const withSamples = rows.filter((r) => r.meta?.sampleValues.length);
  if (withSamples.length) {
    lines.push("## Sample values");
    lines.push("");
    lines.push(
      "First non-null sample values for each probed field — useful for sanity-checking units and scale."
    );
    lines.push("");
    const seen = new Set<string>();
    for (const r of withSamples) {
      const key = `${r.usage.indexPatterns[0]}|${r.usage.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`### \`${r.usage.field}\` (${r.usage.indexPatterns[0]})`);
      lines.push("");
      lines.push("```");
      for (const v of r.meta!.sampleValues) {
        lines.push(JSON.stringify(v));
      }
      lines.push("```");
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

// ——— Main ————————————————————————————————————————————————————————————

async function main() {
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : DEFAULT_OUT;
  const skipSamples = args.includes("--no-samples");
  const dryRun = args.includes("--dry-run");

  const usages = loadAllUsages();
  console.log(`extracted ${usages.length} (tool, field, aggregation) usages from src/tools/`);

  if (dryRun) {
    const byTool = new Map<string, Usage[]>();
    for (const u of usages) {
      if (!byTool.has(u.tool)) byTool.set(u.tool, []);
      byTool.get(u.tool)!.push(u);
    }
    for (const [tool, list] of byTool) {
      console.log(`\n# ${tool} (${list.length})`);
      for (const u of list) {
        console.log(
          `  ${u.aggregation}(${u.field}) on ${u.indexPatterns.join(",") || "—"} ${u.hasTimeFilter ? "[time-bounded]" : "[UNBOUNDED]"}`
        );
      }
    }
    return;
  }

  const rows: AuditRow[] = [];
  // Dedup by (field, agg, indexPattern set) so we don't probe the same thing
  // repeatedly for re-used fields across tools. Keep all tool references.
  const byFieldAgg = new Map<string, Usage[]>();
  for (const u of usages) {
    const k = `${u.field}|${u.aggregation}|${u.indexPatterns.join(",")}`;
    if (!byFieldAgg.has(k)) byFieldAgg.set(k, []);
    byFieldAgg.get(k)!.push(u);
  }

  let i = 0;
  for (const group of byFieldAgg.values()) {
    i++;
    const rep = group[0];
    process.stdout.write(`[${i}/${byFieldAgg.size}] ${rep.field} × ${rep.aggregation} on ${rep.indexPatterns.join(",") || "—"}\n`);
    const meta = await resolveFieldMeta(rep.indexPatterns, rep.field);
    if (!skipSamples && meta.esType) {
      meta.sampleValues = await fetchSamples(rep.indexPatterns, rep.field);
    }
    for (const u of group) {
      const { v, r } = verdictFor(u, meta);
      rows.push({ usage: u, meta, verdict: v, rationale: r });
    }
  }

  const report = renderReport(rows);
  writeFileSync(out, report);
  console.log(`\nwrote ${rows.length} audit rows to ${out}`);

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `summary: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
