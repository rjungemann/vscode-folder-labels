import * as vscode from 'vscode';

// Color label indices matching macOS Finder
export const LABEL_COLORS = {
  None: 0,
  Gray: 1,
  Green: 2,
  Purple: 3,
  Blue: 4,
  Yellow: 5,
  Red: 6,
  Orange: 7,
} as const;

export type LabelColor = keyof typeof LABEL_COLORS;
export type ColorIndex = typeof LABEL_COLORS[LabelColor];

// Map color index to VS Code ThemeColor
// Note: FileDecoration.color only accepts ThemeColor, not string hex codes
// We use custom theme colors defined in package.json
export const COLOR_THEME_MAP: Record<number, vscode.ThemeColor> = {
  0: new vscode.ThemeColor('badge.background'),
  1: new vscode.ThemeColor('folderLabels.gray'),
  2: new vscode.ThemeColor('folderLabels.green'),
  3: new vscode.ThemeColor('folderLabels.purple'),
  4: new vscode.ThemeColor('folderLabels.blue'),
  5: new vscode.ThemeColor('folderLabels.yellow'),
  6: new vscode.ThemeColor('folderLabels.red'),
  7: new vscode.ThemeColor('folderLabels.orange'),
};

// Unicode colored circle character
export const BADGE_CHAR = '\u25CF'; // ●

// Extended attribute name for macOS Finder tags
export const XATTR_TAGS = 'com.apple.metadata:_kMDItemUserTags';
