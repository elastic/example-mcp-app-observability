/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from "react";
import type { FixtureSet } from "./types";
import { manageAlertsFixtures } from "./manage-alerts";
import { apmHealthSummaryFixtures } from "./apm-health-summary";
import { anomalyExplainerFixtures } from "./anomaly-explainer";
import { apmServiceDependenciesFixtures } from "./apm-service-dependencies";
import { k8sBlastRadiusFixtures } from "./k8s-blast-radius";
import { observeFixtures } from "./observe";

import { App as AnomalyExplainerApp } from "../../src/views/anomaly-explainer/App";
import { App as ApmHealthSummaryApp } from "../../src/views/apm-health-summary/App";
import { App as ApmServiceDependenciesApp } from "../../src/views/apm-service-dependencies/App";
import { App as K8sBlastRadiusApp } from "../../src/views/k8s-blast-radius/App";
import { App as ManageAlertsApp } from "../../src/views/manage-alerts/App";
import { App as ObserveApp } from "../../src/views/observe/App";

export interface ViewEntry {
  slug: string;
  label: string;
  Component: React.ComponentType;
  fixtures: FixtureSet;
  defaultState: string;
}

export const VIEWS: ViewEntry[] = [
  { slug: "manage-alerts",            label: "Manage alerts",            Component: ManageAlertsApp,            fixtures: manageAlertsFixtures,            defaultState: "list" },
  { slug: "apm-health-summary",       label: "APM health summary",       Component: ApmHealthSummaryApp,        fixtures: apmHealthSummaryFixtures,        defaultState: "degraded" },
  { slug: "anomaly-explainer",        label: "Anomaly explainer",        Component: AnomalyExplainerApp,        fixtures: anomalyExplainerFixtures,        defaultState: "detail" },
  { slug: "apm-service-dependencies", label: "APM service dependencies", Component: ApmServiceDependenciesApp,  fixtures: apmServiceDependenciesFixtures,  defaultState: "checkoutGraph" },
  { slug: "k8s-blast-radius",         label: "K8s blast radius",         Component: K8sBlastRadiusApp,          fixtures: k8sBlastRadiusFixtures,          defaultState: "atRisk" },
  { slug: "observe",                  label: "Observe",                  Component: ObserveApp,                 fixtures: observeFixtures,                 defaultState: "conditionMet" },
];
