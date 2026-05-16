#!/usr/bin/env bash
# Build the folder-labels-helper Swift binary.
# Produces a universal (arm64 + x86_64) binary when both targets are available,
# otherwise produces a native-arch binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
SRC="$ROOT/bin/src/main.swift"
OUT="$ROOT/bin/folder-labels-helper"

echo "Building folder-labels-helper from $SRC ..."

ARM_OUT="$OUT-arm64"
X86_OUT="$OUT-x86_64"

# Build arm64
if swiftc -O "$SRC" -target arm64-apple-macos12.0 -o "$ARM_OUT" 2>/dev/null; then
    echo "  arm64 OK"
    ARM_BUILT=1
else
    ARM_BUILT=0
fi

# Build x86_64
if swiftc -O "$SRC" -target x86_64-apple-macos12.0 -o "$X86_OUT" 2>/dev/null; then
    echo "  x86_64 OK"
    X86_BUILT=1
else
    X86_BUILT=0
fi

if [[ $ARM_BUILT -eq 1 && $X86_BUILT -eq 1 ]]; then
    lipo -create "$ARM_OUT" "$X86_OUT" -output "$OUT"
    rm "$ARM_OUT" "$X86_OUT"
    echo "  universal binary created"
elif [[ $ARM_BUILT -eq 1 ]]; then
    mv "$ARM_OUT" "$OUT"
    echo "  arm64-only binary (x86_64 cross-compile unavailable)"
elif [[ $X86_BUILT -eq 1 ]]; then
    mv "$X86_OUT" "$OUT"
    echo "  x86_64-only binary"
else
    # Fallback: compile for native arch without explicit target
    swiftc -O "$SRC" -o "$OUT"
    echo "  native-arch binary (no explicit target)"
fi

chmod +x "$OUT"
echo "Done: $OUT"
