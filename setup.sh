#!/bin/sh
# Per-clone setup: enables the tracked git hooks and verifies the AGENTS.md convention.
set -e
git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true
echo "✓ Hooks path set to .githooks/ (pre-commit will run on every commit)"

if [ -e AGENTS.md ] && [ -e CLAUDE.md ]; then
  if [ -L AGENTS.md ] && [ "$(readlink AGENTS.md)" = "CLAUDE.md" ]; then
    echo "✓ AGENTS.md symlink intact"
  else
    echo "⚠ AGENTS.md is not a proper symlink to CLAUDE.md. Restore with:"
    echo "    rm AGENTS.md && ln -s CLAUDE.md AGENTS.md"
  fi
fi

echo ""
echo "Setup complete. See CLAUDE.md for project conventions and the cross-machine workflow."
