#!/usr/bin/env bash
set -euo pipefail

GATEWAY_PORT="${GATEWAY_PORT:-3001}"

exec tailscale funnel --bg "$GATEWAY_PORT"
