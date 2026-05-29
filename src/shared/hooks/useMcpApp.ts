/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useContext } from "react";
import { McpAppContext, type McpAppContextValue } from "./McpAppContext.js";

export function useMcpApp(): McpAppContextValue {
  const ctx = useContext(McpAppContext);
  if (!ctx) throw new Error("useMcpApp must be used within McpAppProvider");
  return ctx;
}
