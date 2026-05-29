/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { McpAppProvider } from "@shared/hooks/McpAppProvider";

createRoot(document.getElementById("root")!).render(
  <McpAppProvider name="manage-alerts" version="1.0.0">
    <App />
  </McpAppProvider>
);
