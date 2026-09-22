#!/usr/bin/env bash
# Create the GitHub repository (if needed) and push this project to it.
#
# Usage:
#   GITHUB_TOKEN=ghp_xxx bash scripts/publish.sh <github-username> [repo-name]
#
# The token needs the `repo` scope (or fine-grained "Contents: read and write"
# on the target repository). It is read from the environment only — it is never
# written to disk or embedded in the git remote URL.
set -euo pipefail

USER_NAME="${1:-}"
REPO="${2:-dsh-mdviewer}"

if [ -z "$USER_NAME" ]; then
  echo "usage: GITHUB_TOKEN=... bash scripts/publish.sh <github-username> [repo-name]" >&2
  exit 1
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "error: GITHUB_TOKEN is not set" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Refuse to publish build output or dependencies.
if git status --short | grep -qE 'node_modules|\.pw-browsers|test-output|src-tauri/target'; then
  echo "error: build artifacts or dependencies are staged; check .gitignore" >&2
  exit 1
fi

# GitHub connectivity from some networks is intermittent, so retry each call a
# few times with a per-attempt timeout instead of hanging on one request.
gh_api() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if curl -sS --max-time 30 --retry 2 --retry-delay 2 "$@"; then
      return 0
    fi
    echo "    network retry $attempt/5" >&2
    sleep 3
  done
  return 1
}

echo "==> checking the token"
LOGIN="$(gh_api -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("login",""))' 2>/dev/null || true)"
if [ -z "$LOGIN" ]; then
  echo "error: could not reach GitHub or the token was rejected" >&2
  exit 1
fi

# The repo may be owned by a user or an organisation, so compare case-insensitively.
if [ "$(echo "$LOGIN" | tr '[:upper:]' '[:lower:]')" != "$(echo "$USER_NAME" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "note: token belongs to '$LOGIN', not '$USER_NAME' — pushing to $USER_NAME/$REPO anyway"
fi

echo "==> pushing"
# Push over HTTPS with the token supplied per-invocation via a credential
# helper, so it never lands in .git/config.
for attempt in 1 2 3 4 5; do
  if git -c credential.helper='!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f' \
       -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
       push -u "https://github.com/$USER_NAME/$REPO.git" HEAD:main; then
    echo
    echo "pushed to https://github.com/$USER_NAME/$REPO"
    exit 0
  fi
  echo "    push attempt $attempt failed, retrying" >&2
  sleep 5
done

echo "error: push failed after 5 attempts" >&2
exit 1
