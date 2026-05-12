import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ColorIndex, LABEL_COLORS, XATTR_TAGS } from './types';
import { parseStringArray, buildStringArray } from './bplist';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Map from color index to the full tag string stored in the xattr plist.
 * macOS encodes color labels as "<Name>\n<index>" (literal newline + digit).
 */
const COLOR_TAG_STRINGS: Readonly<Record<number, string>> = {
  [LABEL_COLORS.Gray]:   'Gray\n1',
  [LABEL_COLORS.Green]:  'Green\n2',
  [LABEL_COLORS.Purple]: 'Purple\n3',
  [LABEL_COLORS.Blue]:   'Blue\n4',
  [LABEL_COLORS.Yellow]: 'Yellow\n5',
  [LABEL_COLORS.Red]:    'Red\n6',
  [LABEL_COLORS.Orange]: 'Orange\n7',
};

/** Map from color index to the name used by the `tag` CLI (no trailing newline). */
const COLOR_CLI_NAMES: Readonly<Record<number, string>> = {
  [LABEL_COLORS.Gray]:   'Gray',
  [LABEL_COLORS.Green]:  'Green',
  [LABEL_COLORS.Purple]: 'Purple',
  [LABEL_COLORS.Blue]:   'Blue',
  [LABEL_COLORS.Yellow]: 'Yellow',
  [LABEL_COLORS.Red]:    'Red',
  [LABEL_COLORS.Orange]: 'Orange',
};

const ALL_COLOR_CLI_NAMES = Object.values(COLOR_CLI_NAMES);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the tag string encodes one of the 7 standard Finder colors. */
function isColorTag(tag: string): boolean {
  const nl = tag.indexOf('\n');
  if (nl === -1) { return false; }
  const idx = parseInt(tag.slice(nl + 1), 10);
  return idx >= 1 && idx <= 7;
}

/** Returns the first color index found in a tag array, or undefined. */
function colorIndexFromTags(tags: string[]): ColorIndex | undefined {
  for (const tag of tags) {
    const nl = tag.indexOf('\n');
    if (nl !== -1) {
      const idx = parseInt(tag.slice(nl + 1), 10);
      if (!isNaN(idx) && idx >= 1 && idx <= 7) {
        return idx as ColorIndex;
      }
    }
  }
  return undefined;
}

/**
 * Run a command and capture stdout as a raw Buffer.
 * Rejects with the ExecException (including `code`) on non-zero exit or OS error.
 */
function execFileBuffer(cmd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args], { encoding: 'buffer' }, (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as string));
    });
  });
}

// ---------------------------------------------------------------------------
// tag CLI availability
// ---------------------------------------------------------------------------

let tagCLIAvailable: boolean | null = null;
let hasShownTagWarning = false;

async function checkTagCLI(): Promise<boolean> {
  if (tagCLIAvailable !== null) { return tagCLIAvailable; }
  try {
    await execFileAsync('tag', ['--version']);
    tagCLIAvailable = true;
  } catch {
    tagCLIAvailable = false;
  }
  return tagCLIAvailable;
}

function showTagWarning(): void {
  if (hasShownTagWarning) { return; }
  hasShownTagWarning = true;
  vscode.window.showWarningMessage(
    'Folder Labels: The "tag" CLI is not installed. ' +
    'The extension is using a built-in xattr reader. ' +
    'Install "tag" for best performance: brew install tag',
  );
}

// ---------------------------------------------------------------------------
// Layer 1 — Native: xattr binary I/O + TypeScript bplist parser
// ---------------------------------------------------------------------------

/**
 * Read all raw tag strings for a file by reading the xattr attribute as a
 * binary Buffer and parsing the bplist entirely in TypeScript.
 *
 * Throws when xattr itself is unavailable (ENOENT / EACCES on the binary).
 * Returns [] when the attribute is absent (xattr exits non-zero) or unparseable.
 */
async function readAllTagsNative(filePath: string): Promise<string[]> {
  let buf: Buffer;
  try {
    buf = await execFileBuffer('xattr', ['-p', XATTR_TAGS, filePath]);
    console.debug(`[Folder Labels] xattr returned buffer (${buf.length} bytes) for ${filePath}:`, buf.toString('hex').slice(0, 64));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') {
      // ENOENT / EACCES — xattr binary not accessible; re-throw so caller can fall back.
      console.debug(`[Folder Labels] xattr binary not accessible (${code}) for ${filePath}`);
      throw err;
    }
    // Non-zero exit code — attribute absent or permission denied on this file.
    console.debug(`[Folder Labels] xattr non-zero exit (attribute absent?) for ${filePath}`);
    return [];
  }
  const parsed = parseStringArray(buf);
  console.debug(`[Folder Labels] parseStringArray returned:`, parsed);
  return parsed ?? [];
}

async function readLabelNative(filePath: string): Promise<ColorIndex | undefined> {
  console.debug(`[Folder Labels] readLabelNative: reading tags for ${filePath}`);
  const tags = await readAllTagsNative(filePath);
  console.debug(`[Folder Labels] readLabelNative: got tags for ${filePath}:`, tags);
  const result = colorIndexFromTags(tags);
  console.debug(`[Folder Labels] readLabelNative: colorIndexFromTags returned ${result}`);
  return result;
}

async function writeLabelNative(filePath: string, colorIndex: ColorIndex): Promise<boolean> {
  const colorTagStr = COLOR_TAG_STRINGS[colorIndex];
  if (!colorTagStr) { return false; }

  // Read existing tags so we can preserve any non-color tags the user may have set.
  let existingTags: string[] = [];
  try {
    existingTags = await readAllTagsNative(filePath);
  } catch {
    // Can't read existing tags — proceed with an empty base (non-color tags may be lost,
    // but this only happens when xattr is unavailable, which is very unlikely on macOS).
  }

  const nonColorTags = existingTags.filter(t => !isColorTag(t));
  const newTags = [...nonColorTags, colorTagStr];
  const plistBuf = buildStringArray(newTags);
  const hex = plistBuf.toString('hex');
  console.debug(`[Folder Labels] writeLabelNative: calling xattr -wx with hex (len=${hex.length}):`, hex.slice(0, 80));
  // xattr -wx accepts a hex string and writes the decoded bytes as the attribute value.
  await execFileAsync('xattr', ['-wx', XATTR_TAGS, hex, filePath]);
  return true;
}

async function clearLabelNative(filePath: string): Promise<boolean> {
  let existingTags: string[] = [];
  try {
    existingTags = await readAllTagsNative(filePath);
  } catch {
    // Attribute absent or xattr not accessible — nothing to clear.
    return true;
  }

  const nonColorTags = existingTags.filter(t => !isColorTag(t));

  if (nonColorTags.length === 0) {
    // Delete the whole attribute rather than writing an empty array.
    try {
      await execFileAsync('xattr', ['-d', XATTR_TAGS, filePath]);
    } catch {
      // Attribute may already be absent — not an error.
    }
  } else {
    // Keep non-color tags; write back the filtered list.
    const hex = buildStringArray(nonColorTags).toString('hex');
    await execFileAsync('xattr', ['-wx', XATTR_TAGS, hex, filePath]);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Layer 2 — Fallback: tag CLI (requires `brew install tag`)
// ---------------------------------------------------------------------------

async function readLabelViaTag(filePath: string): Promise<ColorIndex | undefined> {
  const { stdout } = await execFileAsync('tag', ['--list', filePath]);
  // tag --list outputs "filepath\tTag1,Tag2" (filename TAB comma-separated tags).
  const tabIdx = stdout.indexOf('\t');
  const tagPart = tabIdx !== -1 ? stdout.slice(tabIdx + 1).trim() : stdout.trim();
  const tagNames = tagPart ? tagPart.split(',').map(t => t.trim()).filter(Boolean) : [];
  for (const name of tagNames) {
    for (const [idx, cliName] of Object.entries(COLOR_CLI_NAMES)) {
      if (cliName === name) { return parseInt(idx) as ColorIndex; }
    }
  }
  return undefined;
}

async function writeLabelViaTag(filePath: string, colorIndex: ColorIndex): Promise<boolean> {
  const colorName = COLOR_CLI_NAMES[colorIndex];
  // Remove all color labels first so only one color is active.
  await execFileAsync('tag', ['--remove', ALL_COLOR_CLI_NAMES.join(','), filePath]);
  await execFileAsync('tag', ['--add', colorName, filePath]);
  return true;
}

async function clearLabelViaTag(filePath: string): Promise<boolean> {
  await execFileAsync('tag', ['--remove', ALL_COLOR_CLI_NAMES.join(','), filePath]);
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the Finder label color index for a file.
 *
 * Priority:
 *   1. Native: xattr -p (raw Buffer) → TypeScript bplist parser  [no external deps]
 *   2. Fallback: tag CLI (`brew install tag`)
 */
export async function readLabel(filePath: string): Promise<ColorIndex | undefined> {
  console.debug(`[Folder Labels] readLabel called for: ${filePath}`);
  try {
    const result = await readLabelNative(filePath);
    console.debug(`[Folder Labels] readLabelNative returned ${result} for ${filePath}`);
    return result;
  } catch (err) {
    // xattr binary unavailable — fall through.
    console.debug(`[Folder Labels] readLabelNative not available for ${filePath}, trying tag CLI:`, err);
  }

  if (await checkTagCLI()) {
    try {
      const result = await readLabelViaTag(filePath);
      console.debug(`[Folder Labels] readLabelViaTag returned ${result} for ${filePath}`);
      return result;
    } catch (err) {
      console.debug(`[Folder Labels] readLabelViaTag failed for ${filePath}:`, err);
    }
  } else {
    showTagWarning();
  }

  console.debug(`[Folder Labels] readLabel returning undefined for ${filePath}`);
  return undefined;
}

/**
 * Write a Finder label color to a file.
 *
 * Priority:
 *   1. Native: build bplist in TypeScript → xattr -wx
 *   2. Fallback: tag CLI
 */
export async function writeLabel(filePath: string, colorIndex: ColorIndex): Promise<boolean> {
  if (colorIndex === LABEL_COLORS.None) {
    return clearLabel(filePath);
  }

  try {
    return await writeLabelNative(filePath, colorIndex);
  } catch (err) {
    console.debug(`Folder Labels: writeLabelNative failed for ${filePath}:`, err);
  }

  if (await checkTagCLI()) {
    try {
      return await writeLabelViaTag(filePath, colorIndex);
    } catch (err) {
      console.error(`Folder Labels: writeLabelViaTag failed for ${filePath}:`, err);
      vscode.window.showErrorMessage(`Failed to set label: ${err}`);
    }
  } else {
    showTagWarning();
    vscode.window.showErrorMessage(
      'Cannot set Finder label: xattr is unavailable and the "tag" CLI is not installed.',
    );
  }
  return false;
}

/**
 * Clear all Finder color labels from a file.
 *
 * Priority:
 *   1. Native: remove color tags from bplist → xattr -wx (or xattr -d if no tags remain)
 *   2. Fallback: tag CLI
 */
export async function clearLabel(filePath: string): Promise<boolean> {
  try {
    return await clearLabelNative(filePath);
  } catch (err) {
    console.debug(`Folder Labels: clearLabelNative failed for ${filePath}:`, err);
  }

  if (await checkTagCLI()) {
    try {
      return await clearLabelViaTag(filePath);
    } catch (err) {
      console.error(`Folder Labels: clearLabelViaTag failed for ${filePath}:`, err);
    }
  }
  return false;
}

/**
 * Batch-read labels for multiple files (runs in parallel).
 */
export async function readLabels(filePaths: string[]): Promise<Map<string, ColorIndex>> {
  const results = new Map<string, ColorIndex>();
  await Promise.all(
    filePaths.map(async (filePath) => {
      const label = await readLabel(filePath);
      if (label !== undefined) {
        results.set(filePath, label);
      }
    }),
  );
  return results;
}

