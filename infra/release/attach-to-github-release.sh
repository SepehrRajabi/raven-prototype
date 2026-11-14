#!/usr/bin/env bash
# Adds one workflow's files to the GitHub release of the tag being built, and creates the
# release first when there is none yet. Run by the macOS and Linux package workflows from
# the repository root:
#
#   infra/release/attach-to-github-release.sh SHA256SUMS-macos builds
#
# The release may come from either side, so this and release.ps1 (`github`) behave alike:
# whichever runs first creates the release from infra/release/github-release.md and the
# version's notes, and each adds its own files to it. Nothing already published is
# replaced, because a published version never changes. A checksum file is uploaded last,
# so its presence means this workflow's files are complete.
set -euo pipefail

sums_name=$1
dir=$2
tag=${GITHUB_REF_NAME:?}
repo=${GITHUB_REPOSITORY:?}
version=${tag#v}

# A tag that isn't the app's version (a test tag, or a forgotten version bump) builds,
# but is never published: the files would carry the wrong version in their names.
declared=$(jq -r .version apps/desktop/src-tauri/tauri.conf.json)
if [ "$tag" != "v$declared" ]; then
  echo "Tag $tag does not match the app's version $declared (tauri.conf.json). Not publishing." >&2
  exit 1
fi

release_state() {
  gh release view "$tag" --repo "$repo" --json isDraft --jq 'if .isDraft then "draft" else "published" end' 2>/dev/null || echo missing
}

state=$(release_state)
if [ "$state" = missing ]; then
  notes=""
  if [ -f "docs/release-notes/$version.md" ]; then notes=$(cat "docs/release-notes/$version.md"); fi
  body=$(mktemp)
  NOTES="$notes" VERSION="$version" TAG="$tag" REPO="$repo" python3 - infra/release/github-release.md > "$body" <<'PY'
import os, sys
text = open(sys.argv[1], encoding="utf-8").read()
for key in ("version", "tag", "repo"):
    text = text.replace("{{" + key + "}}", os.environ[key.upper()])
# The notes go in last, so nothing written in them is taken for a placeholder.
sys.stdout.write(text.replace("{{notes}}", os.environ["NOTES"].strip()).lstrip("\n"))
PY
  echo "Creating the GitHub release $tag"
  # The other workflow or release.ps1 may create it at the same moment; then use theirs.
  gh release create "$tag" --repo "$repo" --verify-tag --title "Raven $version" --notes-file "$body" \
    || [ "$(release_state)" != missing ]
  rm -f "$body"
  state=$(release_state)
fi
if [ "$state" = draft ]; then
  echo "The release $tag is a draft: release.ps1 is uploading to it, or stopped half way. Run this workflow again by hand once it is published." >&2
  exit 1
fi

existing=$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name')
on_release() { grep -qxF -- "$1" <<< "$existing"; }

if on_release "$sums_name"; then
  echo "$sums_name is already on $tag: these files were published before and are left as they are."
  exit 0
fi

cd "$dir"
files=(*)
for file in "${files[@]}"; do
  if on_release "$file"; then
    echo "$file is on $tag but $sums_name is not, so an earlier upload stopped half way." >&2
    echo "Delete it (gh release delete-asset $tag $file --repo $repo), then run this again." >&2
    exit 1
  fi
done
sha256sum -- "${files[@]}" > "$sums_name"
gh release upload "$tag" --repo "$repo" -- "${files[@]}"
gh release upload "$tag" --repo "$repo" -- "$sums_name"
echo "Added ${#files[@]} files and $sums_name to https://github.com/$repo/releases/tag/$tag"
