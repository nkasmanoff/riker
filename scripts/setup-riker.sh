#!/usr/bin/env bash
#
# setup-riker.sh - one-command build & install of the Riker desktop app on macOS.
#
# Run this on any Mac (Apple Silicon or Intel) to produce a standalone,
# double-clickable Riker.app with the opencode CLI bundled inside it, and
# install it to /Applications. It pins the Node version from .nvmrc (via nvm),
# installs dependencies, vendors the opencode binary, runs the Code-OSS gulp
# packaging task for the target architecture, then installs the result.
#
#   scripts/setup-riker.sh                 # build for this Mac, install to /Applications
#   scripts/setup-riker.sh --arch x64      # cross-build the Intel app
#   scripts/setup-riker.sh --no-install    # leave the app in the output folder
#
# Flags:
#   --arch <arm64|x64>   Target macOS architecture        (default: host arch)
#   --no-install         Don't copy the app to /Applications
#   --skip-deps          Skip `npm install`
#   --skip-bundle        Skip vendoring the opencode binary
#   --skip-build         Reuse an existing packaged app (don't run gulp)
#   -h, --help           Show this help
#
set -euo pipefail

# --- locate the repo root (this script lives in <root>/scripts) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# --- parse args ---
ARCH=""
INSTALL=1
SKIP_DEPS=0
SKIP_BUNDLE=0
SKIP_BUILD=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--arch) ARCH="${2:-}"; shift 2 ;;
		--no-install) INSTALL=0; shift ;;
		--skip-deps) SKIP_DEPS=1; shift ;;
		--skip-bundle) SKIP_BUNDLE=1; shift ;;
		--skip-build) SKIP_BUILD=1; shift ;;
		-h|--help) sed -n '3,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "Unknown option: $1" >&2; exit 1 ;;
	esac
done

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# --- platform / arch ---
[[ "$(uname -s)" == "Darwin" ]] || die "This script targets macOS. For Windows/Linux, build natively with the matching 'npm run gulp vscode-<os>-<arch>-min' task."

if [[ -z "$ARCH" ]]; then
	case "$(uname -m)" in
		arm64) ARCH="arm64" ;;
		x86_64) ARCH="x64" ;;
		*) die "Unsupported host arch: $(uname -m)" ;;
	esac
fi
[[ "$ARCH" == "arm64" || "$ARCH" == "x64" ]] || die "--arch must be arm64 or x64 (got '$ARCH')"

HOST_ARCH="arm64"; [[ "$(uname -m)" == "x86_64" ]] && HOST_ARCH="x64"
CROSS=0; [[ "$ARCH" != "$HOST_ARCH" ]] && CROSS=1

APP_NAME="$(node -p "require('$ROOT/product.json').nameLong" 2>/dev/null || echo Riker)"
OUT_DIR="$(cd "$ROOT/.." && pwd)/VSCode-darwin-$ARCH"
APP_PATH="$OUT_DIR/$APP_NAME.app"

log "Building $APP_NAME for macOS $ARCH (host: $HOST_ARCH)$([[ $CROSS == 1 ]] && echo ' (cross-build)')"

# --- Node version (pin to .nvmrc via nvm when available) ---
WANT_NODE="$(cat "$ROOT/.nvmrc" 2>/dev/null | tr -d '[:space:]')"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
	# shellcheck disable=SC1091
	export NVM_DIR="$HOME/.nvm"; . "$HOME/.nvm/nvm.sh"
	log "Using Node $WANT_NODE via nvm"
	nvm install "$WANT_NODE" >/dev/null
	nvm use "$WANT_NODE" >/dev/null
else
	CUR_NODE="$(node -v 2>/dev/null || echo none)"
	if [[ -n "$WANT_NODE" && "$CUR_NODE" != "v$WANT_NODE" ]]; then
		echo "Warning: nvm not found and Node is $CUR_NODE (.nvmrc wants v$WANT_NODE). Continuing with $CUR_NODE." >&2
	fi
fi
echo "node: $(node -v)  npm: $(npm -v)"

# For a cross-arch build, native prebuilds must match the target.
if [[ $CROSS == 1 ]]; then
	export npm_config_arch="$ARCH"
	export npm_config_target_arch="$ARCH"
	export VSCODE_ARCH="$ARCH"
fi

# --- dependencies ---
if [[ $SKIP_DEPS == 0 ]]; then
	log "Installing dependencies (npm install)"
	npm install
else
	log "Skipping npm install (--skip-deps)"
fi

# --- vendor the opencode binary for the target arch ---
if [[ $SKIP_BUNDLE == 0 ]]; then
	log "Vendoring opencode binary (darwin/$ARCH)"
	BIN="$ROOT/extensions/opencode-agent/bin/opencode"
	NEED_DL=1
	if [[ -f "$BIN" ]]; then
		# Re-download only if the bundled binary's arch doesn't match the target.
		FILE_ARCH="$(file -b "$BIN" 2>/dev/null || echo '')"
		case "$ARCH" in
			arm64) echo "$FILE_ARCH" | grep -q arm64 && NEED_DL=0 ;;
			x64) echo "$FILE_ARCH" | grep -q x86_64 && NEED_DL=0 ;;
		esac
		[[ $NEED_DL == 0 ]] && echo "opencode already bundled for $ARCH; skipping download"
	fi
	if [[ $NEED_DL == 1 ]]; then
		node extensions/opencode-agent/scripts/download-opencode.mjs --platform darwin --arch "$ARCH" --force
	fi
else
	log "Skipping opencode bundle (--skip-bundle)"
fi

# --- package ---
if [[ $SKIP_BUILD == 0 ]]; then
	log "Packaging (npm run gulp vscode-darwin-$ARCH-min) - this takes a while"
	npm run gulp "vscode-darwin-$ARCH-min"
else
	log "Skipping build (--skip-build)"
fi

[[ -d "$APP_PATH" ]] || die "Built app not found at $APP_PATH"
log "Built: $APP_PATH"

# --- install ---
if [[ $INSTALL == 1 ]]; then
	DEST="/Applications/$APP_NAME.app"
	log "Installing to $DEST"
	rm -rf "$DEST"
	# ditto preserves bundle metadata / symlinks better than cp -R.
	ditto "$APP_PATH" "$DEST"
	# A locally built, unsigned app trips Gatekeeper. Clear quarantine and
	# ad-hoc re-sign so it launches on the machine that built it.
	xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
	if ! codesign --force --deep --sign - "$DEST" 2>/dev/null; then
		echo "Warning: ad-hoc codesign failed; if macOS blocks launch, run:" >&2
		echo "  codesign --force --deep --sign - \"$DEST\"" >&2
	fi
	log "Installed. Launch from /Applications or run: open \"$DEST\""
else
	log "Skipped install (--no-install). App is at: $APP_PATH"
fi

log "Done. $APP_NAME (darwin-$ARCH) is ready."
echo "Reminder: Riker bundles the opencode CLI but not credentials."
echo "On first use, authenticate once with your provider: opencode auth login"
