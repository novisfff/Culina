#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 <publish|remove> <pr-number> [report-directory] [head-sha]" >&2
}

mode="${1:-}"
pr_number="${2:-}"
report_directory="${3:-}"
head_sha="${4:-unknown}"
pages_remote="${PAGES_REMOTE:-origin}"
pages_branch="${PAGES_BRANCH:-gh-pages}"

if [[ "$mode" != "publish" && "$mode" != "remove" ]]; then
  usage
  exit 2
fi

if [[ ! "$pr_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "PR number must be a positive integer." >&2
  exit 2
fi

repository_root="$(git rev-parse --show-toplevel)"
site_directory="$(mktemp -d "${TMPDIR:-/tmp}/culina-playwright-pages.XXXXXX")"
index_file="$(mktemp "${TMPDIR:-/tmp}/culina-playwright-index.XXXXXX")"
rm -f "$index_file"

cleanup() {
  rm -rf -- "$site_directory"
  rm -f -- "$index_file"
}
trap cleanup EXIT

cd "$repository_root"

existing_sha=""
if existing_ref="$(git ls-remote --heads "$pages_remote" "$pages_branch")" && [[ -n "$existing_ref" ]]; then
  existing_sha="${existing_ref%%[[:space:]]*}"
  git fetch --no-tags "$pages_remote" "refs/heads/$pages_branch"
  git archive FETCH_HEAD | tar -xf - -C "$site_directory"
elif [[ "$mode" == "remove" ]]; then
  echo "Pages branch does not exist; there is nothing to remove."
  exit 0
fi

target_directory="$site_directory/playwright/pr-$pr_number"

if [[ "$mode" == "publish" ]]; then
  if [[ -z "$report_directory" || ! -f "$report_directory/index.html" ]]; then
    echo "Playwright report must contain index.html: $report_directory" >&2
    exit 2
  fi

  if find "$report_directory" \( -type l -o -name .git \) -print -quit | grep -q .; then
    echo "Playwright report may not contain symlinks or nested .git paths." >&2
    exit 2
  fi

  rm -rf -- "$target_directory"
  mkdir -p "$target_directory"
  cp -R "$report_directory"/. "$target_directory"/
else
  if [[ ! -d "$target_directory" ]]; then
    echo "No published report exists for PR #$pr_number."
    exit 0
  fi
  rm -rf -- "$target_directory"
fi

if find "$site_directory" -type l -print -quit | grep -q .; then
  echo "Generated Pages snapshot may not contain symlinks." >&2
  exit 2
fi

touch "$site_directory/.nojekyll"
if [[ ! -f "$site_directory/index.html" ]]; then
  {
    echo '<!doctype html>'
    echo '<html lang="zh-CN"><meta charset="utf-8">'
    echo '<meta name="viewport" content="width=device-width,initial-scale=1">'
    echo '<title>Culina Playwright 报告</title>'
    echo '<body><main><h1>Culina Playwright 报告</h1>'
    echo '<p>请从对应 Pull Request 中打开报告链接。</p></main></body></html>'
  } >"$site_directory/index.html"
fi

GIT_INDEX_FILE="$index_file" git read-tree --empty
GIT_INDEX_FILE="$index_file" git --work-tree="$site_directory" add -A
tree_sha="$(GIT_INDEX_FILE="$index_file" git write-tree)"

export GIT_AUTHOR_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

commit_message="ci: ${mode} Playwright report for PR #${pr_number} (${head_sha:0:12})"
commit_sha="$(printf '%s\n' "$commit_message" | git commit-tree "$tree_sha")"

if [[ -n "$existing_sha" ]]; then
  git push "$pages_remote" "$commit_sha:refs/heads/$pages_branch" \
    --force-with-lease="refs/heads/$pages_branch:$existing_sha"
else
  git push "$pages_remote" "$commit_sha:refs/heads/$pages_branch"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "pages_commit=$commit_sha" >>"$GITHUB_OUTPUT"
fi

echo "Published Pages snapshot $commit_sha for PR #$pr_number."
