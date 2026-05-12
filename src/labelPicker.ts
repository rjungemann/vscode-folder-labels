import * as vscode from 'vscode';
import { LABEL_COLORS, COLOR_THEME_MAP, BADGE_CHAR } from './types';

export type ColorPickItem = vscode.QuickPickItem & { colorIndex: number };

/**
 * Create QuickPick items for color selection
 */
export function createColorPickItems(includeNone: boolean = true): ColorPickItem[] {
  const items: ColorPickItem[] = [];
  
  if (includeNone) {
    items.push({
      label: '$(circle-slash) None',
      description: 'Remove label',
      colorIndex: LABEL_COLORS.None,
    });
  }

  // Gray
  items.push({
    label: `${BADGE_CHAR} Gray`,
    description: 'Gray label',
    colorIndex: LABEL_COLORS.Gray,
  });

  // Green
  items.push({
    label: `${BADGE_CHAR} Green`,
    description: 'Green label',
    colorIndex: LABEL_COLORS.Green,
  });

  // Purple
  items.push({
    label: `${BADGE_CHAR} Purple`,
    description: 'Purple label',
    colorIndex: LABEL_COLORS.Purple,
  });

  // Blue
  items.push({
    label: `${BADGE_CHAR} Blue`,
    description: 'Blue label',
    colorIndex: LABEL_COLORS.Blue,
  });

  // Yellow
  items.push({
    label: `${BADGE_CHAR} Yellow`,
    description: 'Yellow label',
    colorIndex: LABEL_COLORS.Yellow,
  });

  // Red
  items.push({
    label: `${BADGE_CHAR} Red`,
    description: 'Red label',
    colorIndex: LABEL_COLORS.Red,
  });

  // Orange
  items.push({
    label: `${BADGE_CHAR} Orange`,
    description: 'Orange label',
    colorIndex: LABEL_COLORS.Orange,
  });

  return items;
}

/**
 * Show the color picker and return the selected color index
 */
export async function showColorPicker(includeNone: boolean = true): Promise<number | undefined> {
  const items = createColorPickItems(includeNone);
  
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a Finder label color',
    title: 'Set Finder Label',
  });
  
  return pick?.colorIndex;
}
