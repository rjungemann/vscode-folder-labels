import * as vscode from 'vscode';
import { ColorIndex, LABEL_COLORS } from './types';
import { writeLabel, clearLabel } from './labelManager';
import { showColorPicker } from './labelPicker';
import { LabelDecorationProvider } from './labelProvider';

export class Commands {
  private provider: LabelDecorationProvider;

  constructor(provider: LabelDecorationProvider) {
    this.provider = provider;
  }

  /**
   * Register all commands
   */
  register(context: vscode.ExtensionContext): void {
    // Set label command
    const setLabelCommand = vscode.commands.registerCommand(
      'folderLabels.setLabel',
      async (uri: vscode.Uri) => {
        await this.setLabel(uri);
      }
    );
    context.subscriptions.push(setLabelCommand);

    // Clear label command
    const clearLabelCommand = vscode.commands.registerCommand(
      'folderLabels.clearLabel',
      async (uri: vscode.Uri) => {
        await this.clearLabel(uri);
      }
    );
    context.subscriptions.push(clearLabelCommand);
  }

  /**
   * Set label on a file or folder
   */
  private async setLabel(uri?: vscode.Uri): Promise<void> {
    // If no URI provided, use the active editor's document or show file picker
    if (!uri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.scheme === 'file') {
        uri = activeEditor.document.uri;
      } else {
        // Show file picker
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: false,
          title: 'Select file or folder to label',
        });
        
        if (!selected || selected.length === 0) {
          return;
        }
        uri = selected[0];
      }
    }

    // Only work with file URIs
    if (uri.scheme !== 'file') {
      vscode.window.showErrorMessage('Please select a file or folder on disk.');
      return;
    }

    // Show color picker
    const colorIndex = await showColorPicker(true);
    
    if (colorIndex === undefined) {
      return; // User cancelled
    }

    if (colorIndex === LABEL_COLORS.None) {
      // Clear label
      await this.performClearLabel(uri);
    } else {
      // Set label - colorIndex is a number but we need ColorIndex type
      await this.performSetLabel(uri, colorIndex as ColorIndex);
    }
  }

  /**
   * Clear label from a file or folder
   */
  private async clearLabel(uri?: vscode.Uri): Promise<void> {
    // If no URI provided, use the active editor's document or show file picker
    if (!uri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.scheme === 'file') {
        uri = activeEditor.document.uri;
      } else {
        // Show file picker
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: false,
          title: 'Select file or folder to clear label',
        });
        
        if (!selected || selected.length === 0) {
          return;
        }
        uri = selected[0];
      }
    }

    // Only work with file URIs
    if (uri.scheme !== 'file') {
      vscode.window.showErrorMessage('Please select a file or folder on disk.');
      return;
    }

    await this.performClearLabel(uri);
  }

  /**
   * Perform the actual label setting
   */
  private async performSetLabel(uri: vscode.Uri, colorIndex: ColorIndex): Promise<void> {
    const filePath = uri.fsPath;
    
    try {
      const success = await writeLabel(filePath, colorIndex);
      
      if (success) {
        // Update the decoration
        this.provider.invalidateCache(uri);
        await this.provider.updateLabel(uri);
        
        vscode.window.showInformationMessage(
          `Finder label set to ${this.getColorName(colorIndex)}.`
        );
      } else {
        vscode.window.showErrorMessage(
          'Failed to set Finder label. Make sure the file exists and you have permission to modify it.'
        );
      }
    } catch (error) {
      console.error('Failed to set label:', error);
      vscode.window.showErrorMessage(
        `Failed to set Finder label: ${error}`
      );
    }
  }

  /**
   * Perform the actual label clearing
   */
  private async performClearLabel(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;
    
    try {
      const success = await clearLabel(filePath);
      
      if (success) {
        // Update the decoration
        this.provider.invalidateCache(uri);
        await this.provider.updateLabel(uri);
        
        vscode.window.showInformationMessage('Finder label cleared.');
      } else {
        vscode.window.showErrorMessage(
          'Failed to clear Finder label. Make sure the file exists and you have permission to modify it.'
        );
      }
    } catch (error) {
      console.error('Failed to clear label:', error);
      vscode.window.showErrorMessage(
        `Failed to clear Finder label: ${error}`
      );
    }
  }

  /**
   * Get the human-readable name for a color index
   */
  private getColorName(colorIndex: ColorIndex): string {
    const names = {
      [LABEL_COLORS.None]: 'None',
      [LABEL_COLORS.Gray]: 'Gray',
      [LABEL_COLORS.Green]: 'Green',
      [LABEL_COLORS.Purple]: 'Purple',
      [LABEL_COLORS.Blue]: 'Blue',
      [LABEL_COLORS.Yellow]: 'Yellow',
      [LABEL_COLORS.Red]: 'Red',
      [LABEL_COLORS.Orange]: 'Orange',
    };
    return names[colorIndex as keyof typeof names] || 'Unknown';
  }
}
