#!/usr/bin/env bash
set -euo pipefail

upstream_url="${UPSTREAM_URL:-https://github.com/enricoros/big-AGI.git}"
origin_url="${ORIGIN_URL:-}"
overlay_paths=(
  '.github/workflows/nightly-pro-integration.yml'
  'tools/automation/nightly-pro-integration.ts'
  'tools/automation/nightly-pro-integration.test.ts'
  'tools/automation/sync-upstream-main.sh'
)

git remote add upstream "$upstream_url" 2>/dev/null || git remote set-url upstream "$upstream_url"
if [[ -n "$origin_url" ]]; then
  git remote set-url origin "$origin_url"
fi
git fetch --no-tags --prune upstream '+refs/heads/main:refs/remotes/upstream/main'
git fetch --no-tags --prune origin '+refs/heads/main:refs/remotes/origin/main'

local_head="$(git rev-parse refs/remotes/origin/main)"
upstream_head="$(git rev-parse refs/remotes/upstream/main)"

if [[ "$local_head" == "$upstream_head" ]]; then
  echo "Fork main matches upstream main but lacks the automation overlay." >&2
  exit 1
fi

head_trailer="$(git show -s --format='%(trailers:key=Upstream-Main-Synced,valueonly)' "$local_head" | tr -d '[:space:]')"
overlay_base="$head_trailer"
if [[ ! "$overlay_base" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Fork main head is not a recognized automation overlay commit and may contain non-automation commits." >&2
  exit 1
fi

parent_line="$(git rev-list --parents -n 1 "$local_head")"
read -r -a parent_fields <<< "$parent_line"
parent_count="$(( ${#parent_fields[@]} - 1 ))"
if [[ "$parent_count" != 1 ]]; then
  echo "Fork main overlay must have exactly one parent." >&2
  exit 1
fi

local_parent="$(git rev-parse "$local_head^")"
if [[ "$local_parent" != "$overlay_base" ]]; then
  echo "Fork main contains non-automation commits above the recognized overlay base." >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$overlay_base" "$upstream_head"; then
  echo "The recorded upstream checkpoint is not an ancestor of current upstream main." >&2
  exit 1
fi

mapfile -t changed_paths < <(git diff-tree --no-commit-id --name-only -r "$local_head")
for path in "${changed_paths[@]}"; do
  allowed=false
  for overlay_path in "${overlay_paths[@]}"; do
    if [[ "$path" == "$overlay_path" ]]; then
      allowed=true
      break
    fi
  done
  if [[ "$allowed" != true ]]; then
    echo "Fork main contains non-automation change: $path" >&2
    exit 1
  fi
done

if [[ "$overlay_base" == "$upstream_head" ]]; then
  echo "Fork main already contains the current automation overlay for $upstream_head"
  exit 0
fi

git checkout --detach "$upstream_head"
git checkout "$local_head" -- "${overlay_paths[@]}"
git add -- "${overlay_paths[@]}"
git commit -m 'Automation: preserve nightly Pro integration' -m "Upstream-Main-Synced: $upstream_head"
new_head="$(git rev-parse HEAD)"
git push --force-with-lease="refs/heads/main:$local_head" origin "$new_head:refs/heads/main"
echo "Rebuilt fork main at $new_head on upstream $upstream_head with the automation overlay"
