/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from "react";
import { SeverityChip } from "@shared/components";
import type { Anomaly } from "../types";
import { entityLabel, fmtRelativeTime, severityFromScore } from "../derive";

export function AnomalyEntityCard({
  anomaly,
  onClick,
}: {
  anomaly: Anomaly;
  onClick: () => void;
}) {
  const sev = anomaly.severity || severityFromScore(anomaly.recordScore);
  const stripeClass =
    sev === "critical" ? "ds-stripe-critical" :
    sev === "major"    ? "ds-stripe-major" :
    "ds-stripe-minor";

  return (
    <button
      type="button"
      className={`anom-entity-card ${stripeClass}`}
      onClick={onClick}
      aria-label={`${entityLabel(anomaly)} score ${Math.round(anomaly.recordScore)}`}
    >
      <div>
        <div className="anom-entity-card-name">{entityLabel(anomaly)}</div>
        <div className="anom-entity-card-meta">
          <SeverityChip severity={sev} label={sev} />
          <span>{anomaly.jobId}</span>
          <span>·</span>
          <span>{fmtRelativeTime(anomaly.timestamp)}</span>
        </div>
      </div>
      <div className="anom-entity-card-score">
        <span className="anom-entity-card-score-value">{Math.round(anomaly.recordScore)}</span>
        <span className="anom-entity-card-score-label">score</span>
      </div>
    </button>
  );
}
