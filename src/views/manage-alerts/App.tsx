/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Manage Alerts view — W3 refresh.
 *
 * Renders the four operation shapes emitted by the manage-alerts tool:
 *
 *   list   → subheader toolkit (Sort / Details / Group), status tabs,
 *            search, and a list → detail split (inline detail pane uses
 *            the list payload so no extra server call is needed).
 *   get    → full-width RuleDetailView.
 *   create → full-width RuleDetailView with a "created" eyebrow + synthesized
 *            RuleSummary (the create payload has flat fields).
 *   delete → confirmation body or a "deleted" card.
 *
 * All operations still emit `investigation_actions` as click-to-send prompts,
 * rendered as a next-steps row under the main content. Interactive enable
 * toggling is out of scope here — the tool doesn't yet expose an update op;
 * that's a future server-side addition.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useApp, AppLike, ToolResultParams } from "@shared/use-app";
import { parseToolResult } from "@shared/parse-tool-result";
import { applyTheme } from "@shared/theme";
import { useDisplayMode } from "@shared/use-display-mode";
import {
  ListDetailLayout,
  DetailPaneHeader,
  SearchInput,
  Subheader,
  SetupNoticeBanner,
  SetupNotice,
  type DropdownOption,
} from "@shared/components";
import { AppGlyph, FullscreenIcon, ExitFullscreenIcon } from "@shared/icons";
import { RuleCard } from "./components/RuleCard";
import { RuleDetailView } from "./components/RuleDetailView";
import { applyGroup, applySearch, applySort, applyStatusTab, statusTabCounts } from "./derive";
import type {
  CreateResult,
  DeleteResult,
  GroupKey,
  ListResult,
  Result,
  RuleSummary,
  SortKey,
  StatusTab,
} from "./types";
import { viewStyles } from "./styles";

const SORT_OPTIONS: DropdownOption<SortKey>[] = [
  { value: "attention", label: "Attention first" },
  { value: "name", label: "Name (A–Z)" },
  { value: "updated", label: "Recently updated" },
  { value: "enabled-first", label: "Enabled first" },
];

const GROUP_OPTIONS: DropdownOption<GroupKey>[] = [
  { value: "none", label: "None" },
  { value: "rule-type", label: "Rule type" },
  { value: "status", label: "Status" },
  { value: "tag", label: "Tag" },
  { value: "index", label: "Index pattern" },
];

const TAB_ORDER: { key: StatusTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "enabled", label: "Enabled" },
  { key: "disabled", label: "Disabled" },
  { key: "errors", label: "Errors" },
];

export function App() {
  const [data, setData] = useState<Result | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const { isFullscreen: fullscreen, toggle: toggleFullscreen } = useDisplayMode(app);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = viewStyles;
    document.head.appendChild(style);
    applyTheme();
    return () => style.remove();
  }, []);

  const handleToolResult = useCallback((params: ToolResultParams) => {
    const d = parseToolResult<Result>(params);
    if (d) setData(d);
  }, []);

  useApp({
    appInfo: { name: "Manage Alerts", version: "1.0.0" },
    onAppCreated: (a) => {
      a.ontoolresult = handleToolResult;
      setApp(a);
    },
  });

  const onSend = useCallback((p: string) => app?.sendMessage(p), [app]);

  // Setup notice (welcome / skill-gap) read from any Result variant. Pass
  // through to every Frame call site below so the banner appears at the
  // top of every state — empty waiting, error, list, detail.
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

  if (!data) return <Frame onToggleFullscreen={toggleFullscreen} fullscreen={fullscreen} body={<Waiting />} {...noticeProps} />;

  if (data.status === "error") {
    return (
      <Frame
        onToggleFullscreen={toggleFullscreen}
        fullscreen={fullscreen}
        {...noticeProps}
        body={
          <div className="rule-error">
            <div className="rule-error-title">manage-alerts failed</div>
            <div className="rule-error-body">{data.error || data.message || "Unknown error."}</div>
          </div>
        }
      />
    );
  }

  if (data.operation === "create") {
    const d = data;
    const rule = createResultToRule(d);
    return (
      <Frame
        onToggleFullscreen={toggleFullscreen}
        fullscreen={fullscreen}
        {...noticeProps}
        body={
          <RuleDetailView
            rule={rule}
            eyebrow={<span>Just created · {d.message ?? "saved to Kibana"}</span>}
          />
        }
        footer={<NextSteps actions={d.investigation_actions} onSend={onSend} />}
      />
    );
  }

  if (data.operation === "get") {
    const d = data;
    return (
      <Frame
        onToggleFullscreen={toggleFullscreen}
        fullscreen={fullscreen}
        {...noticeProps}
        body={
          <RuleDetailView
            rule={d.rule}
            onDelete={() =>
              onSend(
                `Delete the alert rule '${d.rule.name}' (id ${d.rule.id}) via manage-alerts with operation='delete'. Confirm first before dispatching.`,
              )
            }
          />
        }
        footer={<NextSteps actions={d.investigation_actions} onSend={onSend} />}
      />
    );
  }

  if (data.operation === "delete") {
    return (
      <Frame
        onToggleFullscreen={toggleFullscreen}
        fullscreen={fullscreen}
        {...noticeProps}
        body={<DeleteBody d={data} />}
        footer={<NextSteps actions={data.investigation_actions} onSend={onSend} />}
      />
    );
  }

  return (
    <ListView
      d={data}
      fullscreen={fullscreen}
      onToggleFullscreen={toggleFullscreen}
      onSend={onSend}
      noticeProps={noticeProps}
    />
  );
}

// ─── Frame ───────────────────────────────────────────────────────────────────

function Frame({
  children,
  body,
  subheader,
  tabs,
  footer,
  onToggleFullscreen,
  fullscreen,
  setupNotice,
  onDismissNotice,
  noticeOnOpenLink,
}: {
  children?: React.ReactNode;
  body?: React.ReactNode;
  subheader?: React.ReactNode;
  tabs?: React.ReactNode;
  footer?: React.ReactNode;
  onToggleFullscreen: () => void;
  fullscreen: boolean;
  setupNotice?: SetupNotice;
  onDismissNotice?: () => void;
  noticeOnOpenLink?: (url: string) => void;
}) {
  return (
    <div className="ds-view">
      <header className="ds-header">
        <AppGlyph size={20} />
        <h1 className="ds-header-title">Alert rules</h1>
        <div className="ds-header-actions">
          {children}
          <button
            type="button"
            className="ds-btn-icon"
            aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <ExitFullscreenIcon size={14} /> : <FullscreenIcon size={14} />}
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
      {tabs}
      {subheader}
      <div style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>{body}</div>
      {footer}
    </div>
  );
}

// ─── List view ───────────────────────────────────────────────────────────────

function ListView({
  d,
  fullscreen,
  onToggleFullscreen,
  onSend,
  noticeProps,
}: {
  d: ListResult;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onSend: (p: string) => void;
  noticeProps?: {
    setupNotice?: SetupNotice;
    onDismissNotice?: () => void;
    noticeOnOpenLink?: (url: string) => void;
  };
}) {
  const [search, setSearch] = useState("");
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [sort, setSort] = useState<SortKey>("attention");
  const [group, setGroup] = useState<GroupKey>("none");
  const [showDetails, setShowDetails] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const counts = useMemo(() => statusTabCounts(d.rules), [d.rules]);

  const filtered = useMemo(() => {
    const byTab = applyStatusTab(d.rules, statusTab);
    const bySearch = applySearch(byTab, search);
    return applySort(bySearch, sort);
  }, [d.rules, statusTab, search, sort]);

  const grouped = useMemo(() => applyGroup(filtered, group), [filtered, group]);
  const selected = useMemo(
    () => (selectedId ? d.rules.find((r) => r.id === selectedId) ?? null : null),
    [selectedId, d.rules],
  );

  // If the current selection gets filtered out, clear it.
  useEffect(() => {
    if (selectedId && !filtered.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [filtered, selectedId]);

  const tabs = (
    <div className="rule-tabs" role="tablist" aria-label="Status filter">
      {TAB_ORDER.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={statusTab === t.key}
          className="rule-tab"
          onClick={() => setStatusTab(t.key)}
        >
          {t.label}
          <span className="rule-tab-count">{counts[t.key]}</span>
        </button>
      ))}
    </div>
  );

  const subheader = (
    <Subheader
      total={filtered.length}
      itemNoun={filtered.length === 1 ? "alert rule" : "alert rules"}
      sort={{ value: sort, onChange: setSort, options: SORT_OPTIONS }}
      details={{ checked: showDetails, onChange: setShowDetails }}
      group={{ value: group, onChange: setGroup, options: GROUP_OPTIONS }}
    />
  );

  const list = (
    <div className="rule-list">
      {filtered.length === 0 ? (
        <div className="rule-empty">
          <div className="rule-empty-title">No alert rules match.</div>
          <div className="rule-empty-sub">
            {search ? (
              <>Try clearing the search or switching tabs.</>
            ) : (
              <>Try a different status tab — {counts.all} rules total.</>
            )}
          </div>
        </div>
      ) : (
        grouped.map((bucket) => (
          <React.Fragment key={bucket.key}>
            {group !== "none" ? (
              <div className="rule-group-header">
                <span>{bucket.label}</span>
                <span className="rule-group-header-count">· {bucket.rules.length}</span>
              </div>
            ) : null}
            {bucket.rules.map((r) => (
              <RuleCard
                key={`${bucket.key}-${r.id}`}
                rule={r}
                selected={r.id === selectedId}
                detailed={showDetails}
                onClick={() => setSelectedId((prev) => (prev === r.id ? null : r.id))}
              />
            ))}
          </React.Fragment>
        ))
      )}
    </div>
  );

  const detail = selected ? (
    <>
      <DetailPaneHeader
        onBack={() => setSelectedId(null)}
        onClose={() => setSelectedId(null)}
        title={selected.name}
      />
      <RuleDetailView
        rule={selected}
        onDelete={() =>
          onSend(
            `Delete the alert rule '${selected.name}' (id ${selected.id}) via manage-alerts with operation='delete'. Confirm first before dispatching.`,
          )
        }
      />
    </>
  ) : null;

  return (
    <Frame
      fullscreen={fullscreen}
      onToggleFullscreen={onToggleFullscreen}
      {...noticeProps}
      tabs={tabs}
      subheader={subheader}
      body={<ListDetailLayout detail={detail}>{list}</ListDetailLayout>}
      footer={<NextSteps actions={d.investigation_actions} onSend={onSend} />}
    >
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search by name, tag, index…"
      />
    </Frame>
  );
}

// ─── Delete body ─────────────────────────────────────────────────────────────

function DeleteBody({ d }: { d: DeleteResult }) {
  if (d.confirmation_required && d.preview) {
    return (
      <div className="rule-delete-confirm">
        <div className="rule-delete-banner">
          <div className="rule-delete-banner-title">This is irreversible.</div>
          <div className="rule-delete-banner-body">
            The alert rule below will be permanently removed from Kibana.{" "}
            <strong>Reply <code className="mono">yes</code> in chat to confirm</strong>,
            or anything else to cancel.
          </div>
        </div>
        <RuleDetailView
          rule={d.preview}
          eyebrow={<span>Pending deletion</span>}
        />
        <div className="rule-delete-footer" role="status" aria-live="polite">
          <span className="rule-delete-footer-dot" aria-hidden="true" />
          Awaiting confirmation in chat — reply{" "}
          <code className="mono">yes</code> to dispatch.
        </div>
      </div>
    );
  }
  return (
    <div className="rule-delete-confirm">
      <div className="rule-detail-eyebrow" style={{ marginBottom: 8 }}>
        Alert rule deleted
      </div>
      <div className="rule-detail-code">
        {d.message || `Alert rule ${d.rule_id} has been permanently deleted.`}
      </div>
    </div>
  );
}

// ─── Next steps row ──────────────────────────────────────────────────────────

function NextSteps({
  actions,
  onSend,
}: {
  actions?: { label: string; prompt: string }[];
  onSend: (p: string) => void;
}) {
  if (!actions?.length) return null;
  return (
    <div className="rule-next-steps">
      <span className="rule-next-steps-label">Next steps</span>
      {actions.map((a, i) => (
        <button
          key={i}
          type="button"
          className="rule-action"
          onClick={() => onSend(a.prompt)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

// ─── Waiting ─────────────────────────────────────────────────────────────────

function Waiting() {
  return (
    <div className="rule-empty" style={{ padding: 80 }}>
      <div className="rule-empty-title">Waiting for a manage-alerts result…</div>
      <div className="rule-empty-sub">Call the manage-alerts tool to populate this view.</div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The `create` op returns a flat payload; synthesize a RuleSummary so we can
 * reuse RuleDetailView.
 */
function createResultToRule(d: CreateResult): RuleSummary {
  const aggType = d.agg_type || "avg";
  const comparator = d.comparator || ">";
  const threshold = d.threshold;
  const condition = d.metric_field
    ? `${aggType}(${d.metric_field}) ${comparator} ${threshold ?? "?"}`
    : null;
  const window = d.time_size && d.time_unit ? `${d.time_size}${d.time_unit}` : null;
  return {
    id: d.rule_id,
    name: d.rule_name,
    rule_type_id: d.rule_type ?? "observability.rules.custom_threshold",
    enabled: d.enabled ?? true,
    tags: d.tags,
    schedule_interval: d.check_interval,
    condition,
    window,
    index_pattern: d.index_pattern,
    kql_filter: d.kql_filter,
  };
}

