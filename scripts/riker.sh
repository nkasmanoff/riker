#!/usr/bin/env bash
set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 == /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

NAME=$(node -p "require('$ROOT/product.json').nameLong")
EXE=$(node -p "require('$ROOT/product.json').nameShort")
BINARY="$ROOT/.build/electron/$NAME.app/Contents/MacOS/$EXE"

if [[ ! -x "$BINARY" ]]; then
	echo "Packaged binary not found at $BINARY" >&2
	echo "Run 'npm run compile' first." >&2
	exit 1
fi

exec env ELECTRON_RUN_AS_NODE="" "$BINARY" . "$@"
