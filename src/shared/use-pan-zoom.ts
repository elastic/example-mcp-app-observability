/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * usePanZoom — shared pan/zoom behaviour for MCP App SVG diagrams.
 *
 * Provides:
 *   • viewBox state tied to a base canvas size (baseW × baseH)
 *   • wheel-zoom centred on the cursor
 *   • click-drag pan (consumers wire `bgHandlers.onMouseDown` to a
 *     transparent <rect> covering the SVG so node-level mouse events win)
 *   • currentZoom readout + reset helper
 *
 * State resets automatically when baseW / baseH change — i.e. when the
 * underlying tool re-runs and the layout produces a new canvas size.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface UsePanZoomOpts {
  baseW: number | null | undefined;
  baseH: number | null | undefined;
  minZoom?: number;
  maxZoom?: number;
  /** Wheel sensitivity — lower = slower. Default 0.0015 gives smooth trackpad zoom. */
  wheelSensitivity?: number;
}

export interface PanZoom {
  viewBox: ViewBox | null;
  currentZoom: number;
  isDragging: boolean;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  minZoom: number;
  maxZoom: number;
  applyZoom: (factor: number, focusX?: number, focusY?: number) => void;
  resetView: () => void;
  // Spread these onto the <svg> element.
  svgHandlers: {
    onWheel: (e: React.WheelEvent<SVGSVGElement>) => void;
    onMouseMove: (e: React.MouseEvent) => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
  };
  // Spread this onto the transparent background <rect> covering the viewBox.
  bgHandlers: {
    onMouseDown: (e: React.MouseEvent) => void;
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function usePanZoom({
  baseW,
  baseH,
  minZoom = 0.5,
  maxZoom = 4,
  wheelSensitivity = 0.0015,
}: UsePanZoomOpts): PanZoom {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; vb: ViewBox } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Re-sync viewBox whenever the underlying canvas size changes (new tool result).
  useEffect(() => {
    if (baseW && baseH) {
      setViewBox({ x: 0, y: 0, w: baseW, h: baseH });
    }
  }, [baseW, baseH]);

  const currentZoom = useMemo(() => {
    if (!baseW || !viewBox) return 1;
    return baseW / viewBox.w;
  }, [baseW, viewBox]);

  const applyZoom = useCallback(
    (factor: number, focusX?: number, focusY?: number) => {
      if (!baseW || !baseH || !viewBox) return;
      const currentZoomNow = baseW / viewBox.w;
      const nextZoom = clamp(currentZoomNow * factor, minZoom, maxZoom);
      if (nextZoom === currentZoomNow) return;
      const nextW = baseW / nextZoom;
      const nextH = baseH / nextZoom;
      const fx = focusX ?? viewBox.x + viewBox.w / 2;
      const fy = focusY ?? viewBox.y + viewBox.h / 2;
      const nextX = fx - ((fx - viewBox.x) * nextW) / viewBox.w;
      const nextY = fy - ((fy - viewBox.y) * nextH) / viewBox.h;
      setViewBox({ x: nextX, y: nextY, w: nextW, h: nextH });
    },
    [baseW, baseH, viewBox, minZoom, maxZoom]
  );

  const screenToViewBox = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg || !viewBox) return null;
      const rect = svg.getBoundingClientRect();
      const relX = (clientX - rect.left) / rect.width;
      const relY = (clientY - rect.top) / rect.height;
      return {
        x: viewBox.x + relX * viewBox.w,
        y: viewBox.y + relY * viewBox.h,
      };
    },
    [viewBox]
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const focal = screenToViewBox(e.clientX, e.clientY);
      // Proportional to actual deltaY so trackpad (small deltas, many events)
      // and mouse wheel (large deltas, few events) feel consistent. Clamp
      // per-event change so a single hard scroll can't jump more than ~35%.
      const raw = -e.deltaY * wheelSensitivity;
      const clamped = clamp(raw, -0.3, 0.3);
      const factor = Math.exp(clamped);
      applyZoom(factor, focal?.x, focal?.y);
    },
    [applyZoom, screenToViewBox, wheelSensitivity]
  );

  const onBgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!viewBox) return;
      if (e.button !== 0) return;
      dragRef.current = { startX: e.clientX, startY: e.clientY, vb: viewBox };
      setIsDragging(true);
    },
    [viewBox]
  );

  const onSvgMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const { startX, startY, vb } = dragRef.current;
    const dx = ((e.clientX - startX) * vb.w) / rect.width;
    const dy = ((e.clientY - startY) * vb.h) / rect.height;
    setViewBox({ x: vb.x - dx, y: vb.y - dy, w: vb.w, h: vb.h });
  }, []);

  const onSvgMouseUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null;
      setIsDragging(false);
    }
  }, []);

  const resetView = useCallback(() => {
    if (!baseW || !baseH) return;
    setViewBox({ x: 0, y: 0, w: baseW, h: baseH });
  }, [baseW, baseH]);

  return {
    viewBox,
    currentZoom,
    isDragging,
    svgRef,
    minZoom,
    maxZoom,
    applyZoom,
    resetView,
    svgHandlers: {
      onWheel,
      onMouseMove: onSvgMouseMove,
      onMouseUp: onSvgMouseUp,
      onMouseLeave: onSvgMouseUp,
    },
    bgHandlers: {
      onMouseDown: onBgMouseDown,
    },
  };
}
