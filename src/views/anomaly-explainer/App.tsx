/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Anomaly Explainer view — W4 refresh.
 *
 *   detail   one anomaly in focus (or many resolving to a single entity).
 *            ScoreRing summary, FactCol of metrics, time-series chart,
 *            collapsible related anomalies, and an investigation-action
 *            "Take Action" bar.
 *
 *   overview many anomalies across many entities. SeverityDonut KPI strip,
 *            sort + group toolkit, and a list of entity cards. Clicking a
 *            card sends a drill-down prompt to the LLM (the overview payload
 *            doesn't carry full per-anomaly detail).
 *
 * Dispatches between the two modes are inferred from the payload via
 * `pickMode` — no input knob.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useApp, AppLike, ToolResultParams } from "@shared/use-app";
import { parseToolResult } from "@shared/parse-tool-result";
import { applyTheme } from "@shared/theme";
import { useDisplayMode } from "@shared/use-display-mode";
import {
  DetailPaneHeader,
  ListDetailLayout,
  QueryPill,
  SeverityDonut,
  Subheader,
  SetupNoticeBanner,
  SetupNotice,
  type DropdownOption,
} from "@shared/components";
import { AppGlyph, ExitFullscreenIcon, FullscreenIcon } from "@shared/icons";
import { AnomalyDetailView } from "./components/AnomalyDetailView";
import { AnomalyEntityCard } from "./components/AnomalyEntityCard";
import { applySort, entityLabel, pickMode, severityCounts } from "./derive";
import type { Anomaly, AnomalyData, GroupKey, SortKey } from "./types";
import { viewStyles } from "./styles";

const SORT_OPTIONS: DropdownOption<SortKey>[] = [
  { value: "score", label: "Risk score" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Entity name" },
];

const GROUP_OPTIONS: DropdownOption<GroupKey>[] = [
  { value: "none", label: "None" },
  { value: "severity", label: "Severity" },
  { value: "job", label: "ML job" },
];

export function App() {
  const [data, setData] = useState<AnomalyData | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);
  const { isFullscreen, toggle: toggleFullscreen } = useDisplayMode(app);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = viewStyles;
    document.head.appendChild(style);
    applyTheme();
    return () => style.remove();
  }, []);

  const handleToolResult = useCallback((params: ToolResultParams) => {
    const d = parseToolResult<AnomalyData>(params);
    if (d) setData(d);
  }, []);

  useApp({
    appInfo: { name: "Anomaly Explainer", version: "1.0.0" },
    onAppCreated: (a) => {
      a.ontoolresult = handleToolResult;
      setApp(a);
    },
  });

  const onSend = useCallback((p: string) => app?.sendMessage(p), [app]);

  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const setupNotice = data
    ? (data as { _setup_notice?: SetupNotice })._setup_notice
    : undefined;
  const onDismissNotice =
    setupNotice?.type === "welcome" && app
      ? () => {
          setNoticeDismissed(true);
          app.callServerTool({ name: "_setup-dismiss-welcome", arguments: {} }).catch(() => {});
        }
      : undefined;
  const noticeOnOpenLink = app
    ? (url: string) => { app.openLink({ url }).catch(() => {}); }
    : undefined;
  const noticeProps = {
    setupNotice: !noticeDismissed ? setupNotice : undefined,
    onDismissNotice,
    noticeOnOpenLink,
  };

  const mode = useMemo(() => pickMode(data), [data]);

  if (!data || !mode) {
    return (
      <Frame
        isFullscreen={isFullscreen}
        toggleFullscreen={toggleFullscreen}
        body={<Waiting />}
        {...noticeProps}
      />
    );
  }

  if (mode === "detail") {
    const top = data.anomalies![0];
    const headerPills: { label: string; value: string }[] = [];
    if (data.filters?.jobId) headerPills.push({ label: "job", value: data.filters.jobId });
    if (data.filters?.entity) headerPills.push({ label: "entity", value: data.filters.entity });
    if (data.filters?.lookback) headerPills.push({ label: "lookback", value: data.filters.lookback });

    return (
      <Frame
        isFullscreen={isFullscreen}
        toggleFullscreen={toggleFullscreen}
        contextRow={
          headerPills.length > 0 ? (
            <div className="anom-context-row">
              {headerPills.map((p) => (
                <QueryPill key={p.label}>{p.label}: {p.value}</QueryPill>
              ))}
            </div>
          ) : undefined
        }
        headline={data.headline && headerPills.length === 0 ? data.headline : undefined}
        body={<AnomalyDetailView top={top} data={data} onSend={onSend} />}
        {...noticeProps}
      />
    );
  }

  // overview
  return (
    <OverviewView
      data={data}
      onSend={onSend}
      isFullscreen={isFullscreen}
      toggleFullscreen={toggleFullscreen}
      noticeProps={noticeProps}
    />
  );
}

// ─── Paginator ───────────────────────────────────────────────────────────────
//
// Compact prev/next + range strip that sits at the bottom of the anomaly
// list. Single page count → no controls render (saves chrome on small
// result sets). Range string is always inclusive 1-indexed for human
// reading: "Showing 1–10 of 25". Keyboard: tab to either button + Enter.

const PAGE_SIZE_OPTIONS = [5, 10, 25, 50] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

function Paginator({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  pageSize,
  onPageSizeChange,
  onPrev,
  onNext,
}: {
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  pageSize: number;
  onPageSizeChange: (n: PageSize) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  // Always render the per-page control, even on a single-page result —
  // so the user can dial down to 5/page if their list is short and they
  // want denser pagination, or up to 50/page on a long list. Prev/Next
  // are disabled-styled when there's only one page.
  return (
    <div className="anom-paginator" role="navigation" aria-label="Anomaly list pagination">
      <span className="anom-paginator-range">
        {total === 0 ? (
          "0 results"
        ) : (
          <>
            Showing <strong>{rangeStart}</strong>–<strong>{rangeEnd}</strong> of{" "}
            <strong>{total}</strong>
          </>
        )}
      </span>
      <label className="anom-paginator-perpage">
        <span>Per page:</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value) as PageSize)}
          aria-label="Items per page"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <div className="anom-paginator-controls">
        <button
          type="button"
          className="anom-paginator-btn"
          onClick={onPrev}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          ← Prev
        </button>
        <span className="anom-paginator-page" aria-current="page">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          className="anom-paginator-btn"
          onClick={onNext}
          disabled={page >= pageCount}
          aria-label="Next page"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Overview view ───────────────────────────────────────────────────────────

function OverviewView({
  data,
  onSend,
  isFullscreen,
  toggleFullscreen,
  noticeProps,
}: {
  data: AnomalyData;
  onSend: (p: string) => void;
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
  noticeProps?: {
    setupNotice?: SetupNotice;
    onDismissNotice?: () => void;
    noticeOnOpenLink?: (url: string) => void;
  };
}) {
  const anomalies = data.anomalies ?? [];
  const counts = useMemo(() => severityCounts(anomalies), [anomalies]);
  const [sort, setSort] = useState<SortKey>("score");
  const [group, setGroup] = useState<GroupKey>("none");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => applySort(anomalies, sort), [anomalies, sort]);

  // Pagination: page-state + size-state. When a group is active, emit
  // group headers inline as the bucket changes within the slice. Both
  // page and pageSize survive sort changes (you'd normally want to
  // keep the same density as you re-sort) but page resets when the
  // underlying list or grouping changes.
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => { setPage(1); }, [anomalies, sort, group, pageSize]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const pageStart = (page - 1) * pageSize;
  const pageEnd = pageStart + pageSize;
  const pageSlice = useMemo(
    () => sorted.slice(pageStart, pageEnd),
    [sorted, pageStart, pageEnd]
  );

  // Bucket-key for the current group, used to decide where to emit
  // inline group headers in the page slice.
  const bucketKey = useCallback((a: Anomaly): string => {
    if (group === "severity") return a.severity;
    if (group === "job") return a.jobId;
    return "all";
  }, [group]);
  const bucketLabel = useCallback((a: Anomaly): string => {
    if (group === "severity") {
      return a.severity === "critical" ? "Critical" : a.severity === "major" ? "Major" : "Minor";
    }
    if (group === "job") return a.jobId;
    return "";
  }, [group]);

  const anomalyKey = (a: Anomaly) =>
    `${a.jobId}|${a.entity ?? entityLabel(a)}|${a.timestamp}`;
  const selected: Anomaly | null = useMemo(() => {
    if (!selectedKey) return null;
    return sorted.find((a) => anomalyKey(a) === selectedKey) ?? null;
  }, [selectedKey, sorted]);

  // If sort/group changes ever filter the selection out, clear it.
  useEffect(() => {
    if (selectedKey && !sorted.some((a) => anomalyKey(a) === selectedKey)) {
      setSelectedKey(null);
    }
  }, [sorted, selectedKey]);

  const lookback = data.filters?.lookback ?? "1h";
  const drillFor = (a: Anomaly) =>
    `Use ml-anomalies to show details for ${a.entity ? `entity "${a.entity}"` : `job_id "${a.jobId}"`} with lookback "${lookback}"`;

  const kpi = (
    <div className="anom-kpi">
      <SeverityDonut
        counts={{
          critical: counts.critical,
          major: counts.major,
          minor: counts.minor,
        }}
        size={64}
        thickness={9}
        title={`${anomalies.length} anomalies by severity`}
      />
      <div className="anom-kpi-totals">
        <div className="anom-kpi-row"><strong>{counts.critical}</strong> critical</div>
        <div className="anom-kpi-row"><strong>{counts.major}</strong> major</div>
        <div className="anom-kpi-row"><strong>{counts.minor}</strong> minor</div>
        <div className="anom-kpi-row" style={{ color: "var(--text-muted)" }}>
          <strong>{anomalies.length}</strong> total · {data.filters?.lookback ?? ""}
        </div>
      </div>
    </div>
  );

  const subheader = (
    <Subheader
      total={anomalies.length}
      itemNoun={anomalies.length === 1 ? "anomaly" : "anomalies"}
      sort={{ value: sort, onChange: setSort, options: SORT_OPTIONS }}
      group={{ value: group, onChange: setGroup, options: GROUP_OPTIONS }}
    />
  );

  // Walk the page slice and emit inline group headers when the bucket key
  // changes. Each header carries the bucket's TOTAL count (across all
  // pages, not just the slice) so users see the group's full size even
  // when only some of its cards fit on the current page.
  const groupTotals = useMemo(() => {
    if (group === "none") return new Map<string, number>();
    const m = new Map<string, number>();
    for (const a of sorted) {
      const k = bucketKey(a);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [sorted, group, bucketKey]);

  const list = (
    <div className="anom-list">
      {pageSlice.length === 0 && (
        <div className="anom-empty-page">No anomalies on this page.</div>
      )}
      {(() => {
        const items: React.ReactNode[] = [];
        let lastBucket = "";
        for (const a of pageSlice) {
          const bk = bucketKey(a);
          if (group !== "none" && bk !== lastBucket) {
            items.push(
              <div key={`hdr-${bk}-${page}`} className="anom-group-header">
                <span>{bucketLabel(a)}</span>
                <span style={{ color: "var(--ds-text-label)" }}>
                  · {groupTotals.get(bk) ?? 0}
                </span>
              </div>
            );
            lastBucket = bk;
          }
          const k = anomalyKey(a);
          items.push(
            <AnomalyEntityCard
              key={k}
              anomaly={a}
              selected={k === selectedKey}
              onClick={() => setSelectedKey((prev) => (prev === k ? null : k))}
            />
          );
        }
        return items;
      })()}
      <Paginator
        page={page}
        pageCount={pageCount}
        rangeStart={pageStart + 1}
        rangeEnd={Math.min(pageEnd, sorted.length)}
        total={sorted.length}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(pageCount, p + 1))}
      />
    </div>
  );

  const detail = selected ? (
    <>
      <DetailPaneHeader
        onBack={() => setSelectedKey(null)}
        onClose={() => setSelectedKey(null)}
        title={entityLabel(selected)}
      />
      <AnomalyDetailView
        top={selected}
        data={data}
        onSend={onSend}
        onDrillDown={() => onSend(drillFor(selected))}
      />
    </>
  ) : null;

  return (
    <Frame
      isFullscreen={isFullscreen}
      toggleFullscreen={toggleFullscreen}
      headline={data.headline}
      body={
        <>
          {kpi}
          {subheader}
          <ListDetailLayout detail={detail}>{list}</ListDetailLayout>
        </>
      }
      {...noticeProps}
    />
  );
}

// ─── Frame ───────────────────────────────────────────────────────────────────

function Frame({
  body,
  contextRow,
  headline,
  isFullscreen,
  toggleFullscreen,
  setupNotice,
  onDismissNotice,
  noticeOnOpenLink,
}: {
  body: React.ReactNode;
  contextRow?: React.ReactNode;
  headline?: string;
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
  setupNotice?: SetupNotice;
  onDismissNotice?: () => void;
  noticeOnOpenLink?: (url: string) => void;
}) {
  return (
    <div className="ds-view">
      <header className="ds-header">
        <AppGlyph size={20} />
        <h1 className="ds-header-title">Anomaly Explainer</h1>
        <div className="ds-header-actions">
          {contextRow}
          <button
            type="button"
            className="ds-btn-icon"
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <ExitFullscreenIcon size={14} /> : <FullscreenIcon size={14} />}
          </button>
        </div>
      </header>
      {setupNotice && (
        <SetupNoticeBanner
          notice={setupNotice}
          onDismiss={onDismissNotice}
          onOpenLink={noticeOnOpenLink}
        />
      )}
      {headline && <div className="anom-headline">{headline}</div>}
      {/* flex: 0 1 auto so the body sizes to natural content (no
       *  whitespace below short lists / single-record detail views)
       *  but still shrinks + scrolls when content exceeds the
       *  ds-view max-height cap. */}
      <div style={{ flex: "0 1 auto", minHeight: 0, overflow: "auto" }}>{body}</div>
    </div>
  );
}

// ─── Waiting ─────────────────────────────────────────────────────────────────

function Waiting() {
  return (
    <div className="anom-empty">
      <div className="anom-empty-title">Waiting for anomaly data…</div>
      <div className="anom-empty-sub">Call ml-anomalies or observe to populate this view.</div>
    </div>
  );
}

