# Performance Improvement Plan

## Current Bottlenecks

### 1. One subprocess per file (critical)

`provideFileDecoration` is called by VS Code for every visible file in the Explorer. Each call eventually reaches `readLabelNative`, which spawns an `xattr -p` subprocess:

```
provideFileDecoration(fileA) → execFileBuffer('xattr', ['-p', attr, fileA])
provideFileDecoration(fileB) → execFileBuffer('xattr', ['-p', attr, fileB])
...
```

For a workspace with 200 visible files, this is 200 subprocess launches on initial paint, each paying:
- Node.js child_process fork overhead
- OS process creation
- `xattr` binary startup/teardown
- IPC buffer copy

The in-process bplist parser (`bplist.ts`) already eliminated the second `plutil` process, but the first `xattr` process per file remains.

### 2. Double I/O on writes

`writeLabelNative` first calls `readAllTagsNative` (one `xattr -p` spawn) to preserve non-color tags, then writes back (one `xattr -wx` spawn). Clear does the same. That is two subprocess round-trips per write.

### 3. `vscode.workspace.fs.stat` in the hot path

`provideFileDecoration` calls `vscode.workspace.fs.stat(uri)` on every invocation to check whether to apply `showOnFiles` / `showOnFolders` settings. This is an async I/O call that runs before the cache check, adding latency even on cache hits when both settings are `true` (the default).

### 4. Debug logging in the hot path

Every `readLabel`, `readLabelNative`, `parseStringArray`, and `provideFileDecoration` call emits multiple `console.debug` lines. In production builds these are no-ops at the JS level but still construct the string arguments (template literals, `.toString()`, `.slice()`). This is negligible individually but accumulates over hundreds of calls.

### 5. Two overlapping file system watchers

`extension.ts` registers both a `**/*` watcher and a `{**/*.*,**/.*}` watcher, both listening to `onDidChange` / `onCreate` / `onDelete`. Change events on any file trigger both handlers — one does a targeted cache invalidation + reread, the other debounces a full cache clear + full refresh. These can fight each other and generate redundant decoration refreshes.

### 6. xattr does not fire on label-only changes

macOS Finder label changes update the `com.apple.metadata:_kMDItemUserTags` xattr but do not necessarily modify `mtime` or trigger VS Code's `FileSystemWatcher` (which uses kqueue/FSEvents on macOS). Live updates from Finder may be silently dropped.

---

## Improvement Opportunities

| # | Approach | Impact | Effort | Notes |
|---|----------|--------|--------|-------|
| A | Batch `xattr -p` calls (multiple file args) | Medium | Low | Quick win; still spawns one process per batch |
| B | Long-running helper daemon (stdio protocol) | High | Medium | Eliminates spawn overhead; reuses one process |
| C | Native N-API addon (`getxattr` / `setxattr`) | High | High | No subprocess at all; requires compiled addon |
| D | Swift/C helper binary (batch via stdin) | High | Medium | Same as B but simpler to ship as a bundled binary |
| E | Remove `stat` from hot path | Low | Low | Easy cleanup |
| F | Strip debug logs from release builds | Low | Low | Use a `DEBUG` flag or esbuild define |
| G | Consolidate file watchers | Low | Low | Remove the second redundant watcher |
| H | Use `MDQuery` / Spotlight for label changes | Medium | High | True xattr-aware notifications without polling |

---

## Recommended Approach: Native Helper Binary (D + B)

### Rationale

Writing a small compiled binary that reads xattrs via the `getxattr(2)` syscall eliminates subprocess overhead almost entirely. Keeping it resident as a long-running daemon eliminates even the one-time startup cost. The binary is small, has no dependencies, and can be bundled directly into the extension's `bin/` directory.

Swift is the best language choice here: it ships with macOS, needs no toolchain to be installed by the user, can call `getxattr()` directly via Darwin imports, and produces a small statically-analyzable binary. The alternative is C, which is smaller but requires more boilerplate for JSON output.

### Wire Protocol

The daemon communicates over stdin/stdout using newline-delimited JSON (NDJSON). This is the same pattern used by language servers and build tools like `watchman`.

**Request** (one JSON object per line, sent by the extension):
```json
{ "id": 1, "op": "read", "paths": ["/a/b/foo", "/a/b/bar", "/a/b/baz"] }
{ "id": 2, "op": "write", "path": "/a/b/foo", "colorIndex": 6 }
{ "id": 3, "op": "clear", "path": "/a/b/foo" }
```

**Response** (one JSON object per line, sent by the daemon):
```json
{ "id": 1, "results": [{ "path": "/a/b/foo", "colorIndex": 6 }, { "path": "/a/b/bar", "colorIndex": null }, { "path": "/a/b/baz", "colorIndex": 2 }] }
{ "id": 2, "ok": true }
{ "id": 3, "ok": true }
```

`colorIndex: null` means no label. Errors include an `"error": "..."` field.

### Binary Design (Swift)

```swift
// bin/folder-labels-helper/main.swift
import Foundation
import Darwin

let XATTR_KEY = "com.apple.metadata:_kMDItemUserTags"

func readColorIndex(path: String) -> Int? {
    var buf = [UInt8](repeating: 0, count: 8192)
    let len = getxattr(path, XATTR_KEY, &buf, buf.count, 0, 0)
    guard len > 0 else { return nil }
    let data = Data(bytes: buf, count: len)
    return parseColorIndexFromBplist(data)  // port of bplist.ts parseStringArray
}

func writeLabel(path: String, colorIndex: Int) throws {
    // Read existing, filter color tags, append new color tag, write back
}

// Main loop: read a line, decode JSON, dispatch, write JSON response
while let line = readLine(strippingNewline: true) {
    // ...
}
```

The bplist parsing logic from `bplist.ts` maps directly to Swift — the binary format handling is identical.

### Extension-Side Changes

Replace `labelManager.ts`'s subprocess calls with a `HelperClient` class:

```ts
class HelperClient {
  private proc: ChildProcess;
  private pending = new Map<number, (r: unknown) => void>();
  private nextId = 0;

  constructor() {
    this.proc = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'inherit'] });
    // read stdout line by line, resolve pending promises
  }

  async readBatch(paths: string[]): Promise<Map<string, ColorIndex>> { ... }
  async write(path: string, colorIndex: ColorIndex): Promise<void> { ... }
  async clear(path: string): Promise<void> { ... }
}
```

`labelProvider.ts`'s `preloadLabels` already groups URIs — it would call `helperClient.readBatch(paths)` in one round-trip instead of N individual `xattr` spawns.

### Build Integration

```
bin/
  folder-labels-helper/
    main.swift
    Package.swift       ← swift package manager for local builds
  folder-labels-helper  ← compiled binary, checked into git (or built on CI)
```

The compiled binary targets `arm64-apple-macos12` and `x86_64-apple-macos12`, lipo'd into a universal binary. It is bundled in the VSIX under `bin/` and referenced via `__dirname` in the extension.

`package.json` adds a `prepackage` script:
```json
"prepackage": "swiftc -O bin/folder-labels-helper/main.swift -o bin/folder-labels-helper"
```

Or use Swift Package Manager for a proper build with `swift build -c release`.

---

## Quick Wins (independent of the binary)

These can be done now without the daemon:

### A. Batch existing `xattr` calls

`xattr -p` accepts multiple file paths. Instead of N individual spawns, group visible files into one call:

```sh
xattr -p com.apple.metadata:_kMDItemUserTags /a/foo /a/bar /a/baz
```

Output is one block per file separated by a header line:
```
/a/foo:
62706c6973 ...
/a/bar:
...
```

Parse the output once. This reduces N spawns to `ceil(N / ARG_MAX_CHUNK)` spawns.

### E. Remove `stat` from the hot path

Move the `showOnFiles` / `showOnFolders` check after the cache hit. When both settings are `true` (default), skip the stat entirely. When a setting is `false`, only stat on cache miss.

```ts
// Fast path: check cache before doing any I/O
const cachedLabel = this.getCachedLabel(filePath);
if (cachedLabel !== undefined) {
  return cachedLabel === LABEL_COLORS.None ? undefined : this.createDecoration(cachedLabel);
}

// Slow path: check settings before spawning a subprocess
if (!this.showOnFiles || !this.showOnFolders) {
  const stats = await vscode.workspace.fs.stat(uri);
  // ...
}
```

### F. Compile-time debug log stripping

Use esbuild's `define` option (already used for bundling) to replace a `DEBUG` constant:

```ts
const DEBUG = false; // replaced by esbuild: --define:DEBUG=false
if (DEBUG) { console.debug(...); }
```

All debug branches are eliminated from the production bundle at zero runtime cost.

### G. Consolidate watchers

Remove the second `workspaceWatcher` in `extension.ts`. The first watcher already handles per-file invalidation. The second watcher's debounced full-refresh adds latency and redundant work.

---

## Expected Impact

| Scenario | Before | After (daemon) |
|----------|--------|----------------|
| 100-file workspace, cold start | ~100 subprocess forks | 1 subprocess fork + 1 batch round-trip |
| Single label read (cache miss) | 1 subprocess fork (~15 ms) | 1 IPC round-trip (~0.5 ms) |
| Write label | 2 subprocess forks | 1 IPC round-trip (read+write in binary) |
| Repeated reads (cache hit) | near-zero (already fast) | near-zero |

The batch `xattr` quick win (approach A) would cut cold-start subprocess count by ~10x with minimal code change and no binary to ship. The daemon eliminates subprocess overhead entirely for all subsequent operations.
