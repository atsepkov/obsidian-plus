#!/bin/bash
# Claude Code Stop hook
# Updates op-tasks entry and notebook portal status to done.
# Reads JSON from stdin with session_id, etc.

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
ID_FILE="/tmp/claude-session-${SESSION_ID}.id"

# 1. Update op-tasks
if [ -f "$ID_FILE" ]; then
    TASK_ID=$(cat "$ID_FILE")
    op-tasks close "$TASK_ID" --resolution "Session completed" 2>/dev/null || true
    rm -f "$ID_FILE"

    # 2. Update notebook portal
    obsidian-plus-cli status \
      --tag "#claude-sessions" \
      --query "$SESSION_ID" \
      --status "x" \
      --json > /dev/null 2>&1 || true
fi
