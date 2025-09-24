#!/bin/bash

# This script scans for vulnerabilities in changed files.
# It can scan for uncommitted changes or changes since a specific commit.
if [ -n "$1" ]; then
  echo "Scanning for files changed since commit $1..."
  changed_files=$(git diff --name-only "$1" HEAD)
else
  echo "Scanning for uncommitted file changes..."
  changed_files=$(git diff --name-only HEAD)
fi

if [ -z "$changed_files" ]; then
  echo "No files changed."
  exit 0
fi

echo "Scanning changed files:"
echo "$changed_files" | while read -r file; do
  if [ -f "$file" ]; then
    echo "Scanning $file..."
    trivy -q -c trivy.yaml fs "$file"
  else
    echo "Skipping $file (not a file or does not exist)."
  fi
done