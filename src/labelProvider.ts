import * as vscode from 'vscode';
import { ColorIndex, LABEL_COLORS, COLOR_THEME_MAP, BADGE_CHAR } from './types';
import { readLabel } from './labelManager';

// Type for the color in FileDecoration - can be ThemeColor or string

// Cache for label decorations to avoid excessive xattr calls
const labelCache = new Map<string, { colorIndex: ColorIndex; timestamp: number }>();
const CACHE_TTL = 5000; // 5 seconds cache TTL in ms

// Pending label reads to avoid duplicate requests
const pendingReads = new Map<string, Promise<void>>();

export class LabelDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri[] | undefined> = new vscode.EventEmitter();
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri[] | undefined> = this._onDidChangeFileDecorations.event;

  private enabled: boolean = true;
  private showOnFiles: boolean = true;
  private showOnFolders: boolean = true;

  constructor() {
    // Load configuration
    this.loadConfiguration();
    
    // Watch for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('folderLabels')) {
        this.loadConfiguration();
        this.refresh();
      }
    });
  }

  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('folderLabels');
    this.enabled = config.get<boolean>('enabled', true);
    this.showOnFiles = config.get<boolean>('showOnFiles', true);
    this.showOnFolders = config.get<boolean>('showOnFolders', true);
  }

  /**
   * Refresh all decorations or specific URIs
   */
  refresh(uri?: vscode.Uri): void {
    if (uri) {
      this._onDidChangeFileDecorations.fire([uri]);
    } else {
      this._onDidChangeFileDecorations.fire(undefined);
    }
  }

  /**
   * Clear the cache for a specific file or all files
   */
  invalidateCache(uri?: vscode.Uri): void {
    if (uri) {
      labelCache.delete(uri.fsPath);
      pendingReads.delete(uri.fsPath);
    } else {
      labelCache.clear();
      pendingReads.clear();
    }
  }

  /**
   * Get cached label for a file path
   */
  private getCachedLabel(filePath: string): ColorIndex | undefined {
    const cached = labelCache.get(filePath);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return cached.colorIndex;
    }
    return undefined;
  }

  /**
   * Set cached label for a file path
   */
  private setCachedLabel(filePath: string, colorIndex: ColorIndex): void {
    labelCache.set(filePath, { colorIndex, timestamp: Date.now() });
  }

  /**
   * Get decoration for a file URI
   * Can be async to read from cache and filesystem
   */
  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    // Check if enabled
    if (!this.enabled) {
      return undefined;
    }

    const filePath = uri.fsPath;
    console.debug(`[Folder Labels] provideFileDecoration called for: ${filePath}`);
    
    // Check if this is a file URI
    const isFile = uri.scheme === 'file';
    if (!isFile) {
      return undefined;
    }

    // Check if we should show on files/folders
    try {
      const stats = await vscode.workspace.fs.stat(uri);
      if (stats.type === vscode.FileType.File && !this.showOnFiles) {
        return undefined;
      }
      if (stats.type === vscode.FileType.Directory && !this.showOnFolders) {
        return undefined;
      }
    } catch {
      return undefined;
    }

    // Try to get from cache first
    const cachedLabel = this.getCachedLabel(filePath);
    console.debug(`[Folder Labels] Cache for ${filePath}: ${cachedLabel}`);
    if (cachedLabel !== undefined) {
      if (cachedLabel === LABEL_COLORS.None) {
        console.debug(`[Folder Labels] No label in cache for ${filePath}`);
        return undefined;
      }
      console.debug(`[Folder Labels] Returning cached decoration for ${filePath}: ${cachedLabel}`);
      return this.createDecoration(cachedLabel);
    }

    // Start async read if not already pending
    if (!pendingReads.has(filePath)) {
      const promise = this.readAndCacheLabel(uri);
      pendingReads.set(filePath, promise);
      
      // Clear pending when done
      promise.finally(() => {
        pendingReads.delete(filePath);
      });
    }
    
    // Wait for the pending read to complete
    const pendingPromise = pendingReads.get(filePath);
    if (pendingPromise) {
      await pendingPromise;
      
      // Now try to get from cache again
      const updatedLabel = this.getCachedLabel(filePath);
      console.debug(`[Folder Labels] After read, cache for ${filePath}: ${updatedLabel}`);
      if (updatedLabel !== undefined) {
        if (updatedLabel === LABEL_COLORS.None) {
          console.debug(`[Folder Labels] No label found after read for ${filePath}`);
          return undefined;
        }
        console.debug(`[Folder Labels] Returning decoration after async read for ${filePath}: ${updatedLabel}`);
        return this.createDecoration(updatedLabel);
      }
    }
    console.debug(`[Folder Labels] No label decoration for ${filePath}`);
    
    // If still no label, return undefined
    return undefined;
  }

  /**
   * Read label asynchronously and cache it, then refresh
   */
  private async readAndCacheLabel(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;
    console.debug(`[Folder Labels] readAndCacheLabel starting for: ${filePath}`);
    
    try {
      const colorIndex = await readLabel(filePath);
      console.debug(`[Folder Labels] readLabel returned for ${filePath}: ${colorIndex}`);
      
      if (colorIndex !== undefined) {
        this.setCachedLabel(filePath, colorIndex);
      } else {
        // No label found, cache as None
        this.setCachedLabel(filePath, LABEL_COLORS.None);
      }
      
      // Refresh just this URI
      console.debug(`[Folder Labels] Calling refresh for ${filePath}`);
      this.refresh(uri);
    } catch (error) {
      console.debug(`Failed to read and cache label for ${filePath}:`, error);
      // Cache as None on error to avoid repeated attempts
      this.setCachedLabel(filePath, LABEL_COLORS.None);
    }
  }

  /**
   * Create a FileDecoration from a color index
   */
  private createDecoration(colorIndex: ColorIndex): vscode.FileDecoration {
    const color = COLOR_THEME_MAP[colorIndex];
    
    return {
      badge: BADGE_CHAR,
      color: color,
      tooltip: this.getColorName(colorIndex),
    };
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

  /**
   * Update label for a specific file and refresh
   */
  async updateLabel(uri: vscode.Uri): Promise<void> {
    this.invalidateCache(uri);
    await this.readAndCacheLabel(uri);
  }

  /**
   * Pre-load labels for a set of URIs (for performance)
   */
  async preloadLabels(uris: readonly vscode.Uri[]): Promise<void> {
    const filePaths = uris.map(u => u.fsPath);
    
    // Filter out already cached or pending
    const toLoad = filePaths.filter(fp => !labelCache.has(fp) && !pendingReads.has(fp));
    
    if (toLoad.length === 0) {
      return;
    }
    
    // Batch read labels
    const results = await Promise.all(
      toLoad.map(async (fp) => {
        const label = await readLabel(fp);
        return { filePath: fp, label: label ?? LABEL_COLORS.None };
      })
    );
    
    // Update cache
    for (const { filePath, label } of results) {
      this.setCachedLabel(filePath, label);
    }
    
    // Refresh all
    this.refresh();
  }
}
