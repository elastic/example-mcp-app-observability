/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Shared 16×16 SVG icon library for MCP App views. All icons render with
 * `fill="none" stroke="currentColor"` so they inherit color from the parent,
 * which lets `.ds-btn-icon`, `.ds-search` and friends restyle them via CSS.
 */

import React from "react";

type IconProps = {
  size?: number;
  className?: string;
  "aria-hidden"?: boolean;
  "aria-label"?: string;
  title?: string;
};

function Svg({
  size = 16,
  className,
  title,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={rest["aria-hidden"] ?? !rest["aria-label"]}
      aria-label={rest["aria-label"]}
      role={rest["aria-label"] ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </Svg>
);

export const FullscreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
  </Svg>
);

export const ExitFullscreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const BackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4 6 8l4 4" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Svg>
);

export const MinusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8h10" />
  </Svg>
);

/**
 * Elastic-style app glyph used in every view header. Two overlapping diamonds
 * in the accent color. Filled (not stroked) because the shape is a logo mark,
 * not an icon in the outline family.
 */
export function AppGlyph({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 1 L17 9 L9 17 L1 9 Z" fill="var(--accent)" opacity="0.9" />
      <path d="M9 4 L14 9 L9 14 L4 9 Z" fill="var(--bg-primary)" />
      <circle cx="9" cy="9" r="1.6" fill="var(--accent)" />
    </svg>
  );
}
