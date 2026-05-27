#!/bin/sh
# install-hooks.sh — install pre-commit hooks in this repo
# Run from repo root. Symlinks scripts/pre-commit → .git/hooks/pre-commit
# Also ensures .gitleaks.toml exists.
#
# Usage:
#   ./scripts/install-hooks.sh              # install in this repo
#   ./scripts/install-hooks.sh --global     # install in all repos under ~/src/

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

TEMPLATE_DIR="${HERMES_TEMPLATES:-$HOME/.hermes/templates}"

install_in_repo() {
    local repo="$1"
    if [ ! -d "$repo/.git" ]; then
        echo "${RED}Not a git repo: $repo${NC}"
        return 1
    fi

    echo "${GREEN}→ Installing hooks in: $(basename "$repo")${NC}"

    # Ensure scripts/ dir exists
    mkdir -p "$repo/scripts"

    # Copy pre-commit script if not present or older
    if [ ! -f "$repo/scripts/pre-commit" ] || [ "$TEMPLATE_DIR/pre-commit" -nt "$repo/scripts/pre-commit" ]; then
        cp "$TEMPLATE_DIR/pre-commit" "$repo/scripts/pre-commit"
        chmod +x "$repo/scripts/pre-commit"
        echo "  ✓ scripts/pre-commit"
    else
        echo "  • scripts/pre-commit (already up to date)"
    fi

    # Copy .gitleaks.toml if not present
    if [ ! -f "$repo/.gitleaks.toml" ]; then
        cp "$TEMPLATE_DIR/.gitleaks.toml" "$repo/.gitleaks.toml"
        echo "  ✓ .gitleaks.toml"
    else
        echo "  • .gitleaks.toml (already exists, skipped)"
    fi

    # Symlink hook
    if [ ! -L "$repo/.git/hooks/pre-commit" ]; then
        if [ -f "$repo/.git/hooks/pre-commit" ]; then
            echo "  ${YELLOW}⚠ Existing pre-commit hook (not symlink), backed up to pre-commit.bak${NC}"
            mv "$repo/.git/hooks/pre-commit" "$repo/.git/hooks/pre-commit.bak"
        fi
        ln -s ../../scripts/pre-commit "$repo/.git/hooks/pre-commit"
        echo "  ✓ .git/hooks/pre-commit → scripts/pre-commit"
    else
        echo "  • .git/hooks/pre-commit (already linked)"
    fi

    echo ""
}

# ── Main ──────────────────────────────────────
if [ ! -d "$TEMPLATE_DIR" ]; then
    echo "${RED}Template dir not found: $TEMPLATE_DIR${NC}"
    echo "Expected: $TEMPLATE_DIR/pre-commit and $TEMPLATE_DIR/.gitleaks.toml"
    exit 1
fi

case "${1:-}" in
    --global|-g)
        # Install in all git repos under common locations
        echo "${GREEN}Installing hooks in all repos...${NC}"
        echo ""
        for repo_dir in "$HOME/src" "$HOME/projects" "$HOME/repos" "$HOME/git"; do
            if [ -d "$repo_dir" ]; then
                for repo in "$repo_dir"/*; do
                    [ -d "$repo/.git" ] && install_in_repo "$repo"
                done
            fi
        done
        # Also scan common one-off repo locations
        for repo in "$HOME/hermes4friends-infra" "$HOME/duckbrain" "$HOME/dexdat-memory" "$HOME/specs" "$HOME/axiom" "$HOME/hivemind"; do
            [ -d "$repo/.git" ] && install_in_repo "$repo"
        done
        ;;
    *)
        # Install in current directory
        install_in_repo "$(pwd)"
        ;;
esac

echo "${GREEN}Done. Test with: git commit --dry-run${NC}"
