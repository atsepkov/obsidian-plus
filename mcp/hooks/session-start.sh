#!/bin/bash
# Claude Code SessionStart hook
# Creates op-tasks entry and appends to notebook portal.
# Reads JSON from stdin with session_id, cwd, etc.

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
CWD=$(echo "$INPUT" | jq -r '.cwd')
PROJECT=$(basename "$CWD")
DEVICE=$(hostname -s)
TIMESTAMP=$(date +%H:%M)

# 1. Create op-tasks entry → get stable ID
TASK_ID=$(op-tasks add "${PROJECT}" -l claude-session \
  -d "{\"session_id\":\"${SESSION_ID}\",\"device\":\"${DEVICE}\",\"cwd\":\"${CWD}\"}" \
  --json | jq -r '.id')
op-tasks status "$TASK_ID" in_progress

# 2. Append to notebook portal with op-tasks ID
obsidian-plus-cli append \
  --tag "#claude-sessions" \
  --content "- [/] #${TASK_ID} ${PROJECT} (${DEVICE}, ${SESSION_ID}) — started ${TIMESTAMP}" \
  --json > /dev/null 2>&1 || true

# 3. Store task ID for session-stop to find
echo "$TASK_ID" > "/tmp/claude-session-${SESSION_ID}.id"
