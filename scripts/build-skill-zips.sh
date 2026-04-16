#!/usr/bin/env bash
# Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
# or more contributor license agreements. Licensed under the Elastic License
# 2.0; you may not use this file except in compliance with the Elastic License
# 2.0.

#
# Build individual skill zips for Claude Desktop upload.
# Produces one .zip per skill in dist/skills/ — each zip contains
# a single top-level folder with exactly one SKILL.md inside.
#
# Usage: ./scripts/build-skill-zips.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/dist/skills"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.zip

echo "==> Building skill zips..."

for SKILL_DIR in "$ROOT/skills"/*/; do
  SKILL_NAME="$(basename "$SKILL_DIR")"

  if [ ! -d "$SKILL_DIR" ]; then
    continue
  fi

  if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
    echo "    Skipping $SKILL_NAME (no SKILL.md)"
    continue
  fi

  OUT_ZIP="$OUT_DIR/${SKILL_NAME}.zip"

  (cd "$ROOT/skills" && zip -r "$OUT_ZIP" "$SKILL_NAME/" \
    -x "*/.DS_Store" \
    -x "*/__pycache__/*")

  echo "    Created ${SKILL_NAME}.zip"
done

echo ""
echo "==> Done! Skill zips are in dist/skills/"
echo ""
echo "Upload each zip individually in Claude Desktop:"
echo "  Customize > Skills > Create Skill > Upload a skill"
