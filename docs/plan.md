# VS Code Folder Labels Extension — Plan

## Overview

A VS Code extension that reads macOS Finder color labels (the colored dots assigned to files and folders in Finder) and displays them as colored badge dots next to filenames in the Explorer sidebar. Users can also assign or clear a label from the Command Palette or via a right-click context menu.

---

## Goals

- Read macOS Finder color labels from the filesystem and display them as colored dots in the VS Code Explorer
- Refresh decorations when files change on disk
- Allow setting a label on any file or folder via:
  - A Command Palette command
  - A right-click context menu entry in the Explorer
- Allow clearing a label (setting it to "None")
- Support all 7 standard Finder label colors: Gray, Green, Purple, Blue, Yellow, Red, Orange

## Non-Goals

- Support for non-macOS platforms (extension will be macOS-only)
- Support for arbitrary Finder tag strings (only the 7 standard color labels)
- Syncing labels across machines or to version control

---

## How macOS Color Labels Work

macOS stores Finder tags as an extended attribute on the file:

```
com.apple.metadata:_kMDItemUserTags
```

The value is a binary plist containing an array of tag name strings. The 7 built-in color labels are stored as strings with a trailing `\n<color_index>` suffix (e.g., `"Red\n6"`). The color index values are:

| Color  | Index |
|--------|-------|
| None   | 0     |
| Gray   | 1     |
| Green  | 2     |
| Purple | 3     |
| Blue   | 4     |
| Yellow | 5     |
| Red    | 6     |
| Orange | 7     |

Reading and writing these attributes requires calling `xattr` via a child process or using a native Node.js module.

---

## Architecture

```
src/
  extension.ts          — activate/deactivate, register providers and commands
  labelProvider.ts      — FileDecorationProvider: maps file URIs to colored badges
  labelManager.ts       — read/write macOS xattr labels (shell interop)
  labelPicker.ts        — QuickPick UI for choosing a label color
  commands.ts           — command handler implementations
package.json            — manifest: commands, menus, activation events
```

### Data Flow

```
File on disk
  └─ xattr read (labelManager)
       └─ color index
            └─ FileDecoration { badge, color } (labelProvider)
                 └─ Explorer sidebar dot
```

When the user sets a label:

```
Right-click / Command Palette
  └─ labelPicker QuickPick
       └─ user selects color
            └─ labelManager writes xattr
                 └─ labelProvider fires onDidChangeFileDecorations
                      └─ Explorer refreshes dot
```

---

## Key VS Code APIs

| API | Purpose |
|-----|---------|
| `vscode.window.registerFileDecorationProvider` | Display badges next to filenames |
| `FileDecoration.badge` | 1–2 character string shown as the dot label (use a unicode circle: `●`) |
| `FileDecoration.color` | `ThemeColor` or custom hex — drives the dot color |
| `vscode.commands.registerCommand` | Register palette and context menu commands |
| `vscode.window.showQuickPick` | Color picker UI |
| `workspace.createFileSystemWatcher` | Watch for external label changes |
| `vscode.Uri` | Identify files in decoration callbacks |

---

## macOS Interop

### Reading a label

```ts
import { execFile } from 'child_process';

// Returns the raw binary plist; pipe through `plutil` to get JSON
execFile('xattr', ['-p', 'com.apple.metadata:_kMDItemUserTags', filePath], ...)
```

Alternative: use the `macos-tags` npm package, which wraps the Objective-C Foundation APIs via a native addon. This is cleaner and avoids plist parsing but adds a native dependency.

Recommended approach: shell out to the `tag` CLI tool (installable via Homebrew: `brew install tag`) for simpler JSON output, with a fallback to `xattr` + `plutil` if `tag` is not available.

### Writing a label

```sh
# Set Red label
tag --set Red <file>

# Clear all color labels
tag --remove Red,Orange,Yellow,Green,Blue,Purple,Gray <file>
```

Or via `xattr` directly by writing a new binary plist.

### Error handling

- If `xattr` or `tag` is not available, show a one-time warning notification
- If a file has no label, return `undefined` from the decoration provider (no decoration)
- Suppress errors for files the user does not have permission to read attributes on

---

## `package.json` Contributions

### Commands

```json
"commands": [
  {
    "command": "folderLabels.setLabel",
    "title": "Set Finder Label…",
    "category": "Folder Labels"
  },
  {
    "command": "folderLabels.clearLabel",
    "title": "Clear Finder Label",
    "category": "Folder Labels"
  }
]
```

### Context Menu

```json
"menus": {
  "explorer/context": [
    {
      "command": "folderLabels.setLabel",
      "group": "navigation"
    },
    {
      "command": "folderLabels.clearLabel",
      "group": "navigation"
    }
  ]
}
```

### Activation Events

```json
"activationEvents": ["onStartupFinished"]
```

### Engine / Platform

```json
"engines": { "vscode": "^1.75.0" },
"os": ["darwin"]
```

---

## Implementation Phases

### Phase 1 — Read and display labels
- [x] Scaffold extension with `yo code` (TypeScript template)
- [x] Implement `labelManager.readLabel(filePath): Promise<number | undefined>`
- [x] Implement `labelProvider` as a `FileDecorationProvider`
- [x] Map color index → `ThemeColor` + unicode dot badge (`●`)
- [x] Register provider on `activate`
- [ ] Manual smoke test in the Explorer

### Phase 2 — Set labels via UI
- [x] Implement `labelPicker`: `showQuickPick` with color names and dot icons
- [x] Implement `labelManager.writeLabel(filePath, colorIndex)`
- [x] Register `folderLabels.setLabel` command wired to picker + write
- [x] Register `folderLabels.clearLabel` command
- [x] Fire `onDidChangeFileDecorations` after write to refresh

### Phase 3 — Live updates
- [x] Create a `FileSystemWatcher` on the workspace to detect external label changes (e.g., changed in Finder)
- [x] Debounce watcher events and re-read labels on change
- [x] Handle file rename/delete gracefully (remove stale cache entries)

### Phase 4 — Polish
- [x] Settings: `folderLabels.enabled` toggle, `folderLabels.showOnFiles`, `folderLabels.showOnFolders`
- [x] Cache label reads (invalidate on watcher events) to avoid excessive `xattr` calls
- [ ] Package and publish to VS Code Marketplace
- [ ] README with screenshots and install instructions

---

## Open Questions / Risks

| Question | Notes |
|----------|-------|
| Performance of `xattr` per file | VS Code calls `provideFileDecoration` per visible file. A short-lived process per call may be slow. Solution: batch reads or use a persistent native module. |
| Permissions | SIP-protected paths and sandboxed apps may block `xattr`. Need graceful degradation. |
| `tag` CLI availability | Cannot assume it is installed. Must support a pure `xattr`+`plutil` path as well. |
| Theme color support | VS Code's file decoration colors are limited to `ThemeColor` tokens. Custom hex colors in decorations may not be fully supported — need to verify in the target VS Code version. |
| macOS version compatibility | Extended attribute format has been stable since OS X 10.9. No concerns expected. |

---

## Implementation: TypeScript Binary plist Parser (Native xattr path)

**Status**: ✅ **Completed**

Instead of spawning an external `plutil` process to parse plist data, a pure TypeScript bplist00 parser and builder handles the xattr read/write entirely in-process. This provides the benefits of a native module (no child processes, no temp files) without the complexity of C++ bindings:

- [x] `src/bplist.ts` — Minimal binary plist00 parser/builder supporting only arrays of strings (all we need for Finder tags)
  - [x] `parseStringArray(buf): string[]` — Deserialize plist from raw Buffer (no shell, no plutil, no files)
  - [x] `buildStringArray(strings): Buffer` — Serialize string array back to bplist00 format
  - [x] Handles inline int encoding, ASCII/UTF-16 strings, and the offset table + trailer
  - [x] Graceful fallback: returns `undefined` if parsing fails (malformed plist)
- [x] `src/labelManager.ts` — Three-layer strategy for maximum compatibility:
  - **Layer 1 (Native—preferred)**: `xattr -p` → `parseStringArray` in TypeScript 
    - No external processes beyond the initial `xattr` binary call
    - No dependencies; pure Node.js Buffer API
    - Fastest for read-only scenarios
  - **Layer 2 (Fallback—fast)**: `tag` CLI if available (requires `brew install tag`)
    - Simpler output format than parsing binary plists
    - But still requires spawning a process per file
  - **Layer 3 (Last resort)**: Falls back gracefully when xattr binary is unavailable
  - [x] **Preserve non-color tags**: When setting/clearing a label, the parser preserves any custom tags the user may have set separately
  - [x] **Batch reads**: `readLabels(filePaths)` spawns concurrent reads via `Promise.all` for better performance with large selections

### Performance notes

- Layer 1 (native TS bplist) avoids spawning `plutil`, reducing overhead vs. the previous `xattr | plutil` pipeline
- For most users (who have `tag` installed), Layer 2 is faster because `tag --list` has simpler output than plist parsing
- Fallback hierarchy ensures the extension works even if `tag` is not installed
- Cache in `labelProvider.ts` prevents redundant reads on the same file

