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
  QueryPill,
  SeverityDonut,
  Subheader,
  type DropdownOption,
} from "@shared/components";
import { AppGlyph, ExitFullscreenIcon, FullscreenIcon } from "@shared/icons";
import { AnomalyDetailView } from "./components/AnomalyDetailView";
import { AnomalyEntityCard } from "./components/AnomalyEntityCard";
import { applyGroup, applySort, pickMode, severityCounts } from "./derive";
import type { AnomalyData, GroupKey, SortKey } from "./types";
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

  const mode = useMemo(() => pickMode(data), [data]);

  if (!data || !mode) {
    return (
      <Frame
        isFullscreen={isFullscreen}
        toggleFullscreen={toggleFullscreen}
        body={<Waiting />}
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
    />
  );
}

// ─── Overview view ───────────────────────────────────────────────────────────

function OverviewView({
  data,
  onSend,
  isFullscreen,
  toggleFullscreen,
}: {
  data: AnomalyData;
  onSend: (p: string) => void;
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
}) {
  const anomalies = data.anomalies ?? [];
  const counts = useMemo(() => severityCounts(anomalies), [anomalies]);
  const [sort, setSort] = useState<SortKey>("score");
  const [group, setGroup] = useState<GroupKey>("none");

  const sorted = useMemo(() => applySort(anomalies, sort), [anomalies, sort]);
  const grouped = useMemo(() => applyGroup(sorted, group), [sorted, group]);

  const lookback = data.filters?.lookback ?? "1h";
  const drill = (entity: string | undefined, jobId: string) => {
    const target = entity ?? `job ${jobId}`;
    onSend(
      `Use ml-anomalies to show details for ${entity ? `entity "${entity}"` : `job_id "${jobId}"`} with lookback "${lookback}"`,
    );
    return target;
  };

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

  const list = (
    <div className="anom-list">
      {grouped.map((bucket) => (
        <React.Fragment key={bucket.key}>
          {group !== "none" && (
            <div className="anom-group-header">
              <span>{bucket.label}</span>
              <span style={{ color: "var(--ds-text-label)" }}>· {bucket.anomalies.length}</span>
            </div>
          )}
          {bucket.anomalies.map((a, i) => (
            <AnomalyEntityCard
              key={`${bucket.key}-${i}`}
              anomaly={a}
              onClick={() => drill(a.entity, a.jobId)}
            />
          ))}
        </React.Fragment>
      ))}
    </div>
  );

  return (
    <Frame
      isFullscreen={isFullscreen}
      toggleFullscreen={toggleFullscreen}
      headline={data.headline}
      body={
        <>
          {kpi}
          {subheader}
          {list}
        </>
      }
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
}: {
  body: React.ReactNode;
  contextRow?: React.ReactNode;
  headline?: string;
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
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
      {headline && <div className="anom-headline">{headline}</div>}
      <div style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>{body}</div>
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

