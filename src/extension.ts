import * as vscode from 'vscode';
import { LabelDecorationProvider } from './labelProvider';
import { Commands } from './commands';
import { disposeHelperClient } from './labelManager';

export function activate(context: vscode.ExtensionContext) {
  console.log('Folder Labels extension is now active!');

  // Create the decoration provider
  const decorationProvider = new LabelDecorationProvider();

  // Register the file decoration provider
  const decorationRegistration = vscode.window.registerFileDecorationProvider(
    decorationProvider
  );
  context.subscriptions.push(decorationRegistration);

  // Register commands
  const commands = new Commands(decorationProvider);
  commands.register(context);

  // Set up file system watcher for external changes
  setupFileWatcher(context, decorationProvider);

  console.log('Folder Labels: Provider and commands registered.');
}

export function deactivate() {
  disposeHelperClient();
  console.log('Folder Labels extension is now inactive!');
}

/**
 * Set up file system watcher to detect external label changes
 */
function setupFileWatcher(context: vscode.ExtensionContext, provider: LabelDecorationProvider): void {
  // Watch for file changes in the workspace
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/*',
    false, // Don't watch for changes in subdirectories by default
    false, // Don't watch for changes in the workspace root by default
    false  // Don't watch for changes in the workspace
  );

  // Debounce function to avoid firing too many events
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const DEBOUNCE_DELAY = 1000; // 1 second debounce

  const refreshAll = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      provider.invalidateCache();
      provider.refresh();
      debounceTimer = undefined;
    }, DEBOUNCE_DELAY);
  };

  // Listen for file changes
  watcher.onDidChange(async (uri) => {
    // A file changed - its label might have changed externally
    console.debug(`File changed: ${uri.fsPath}, invalidating cache`);
    provider.invalidateCache(uri);
    await provider.updateLabel(uri);
  });

  watcher.onDidCreate(async (uri) => {
    // A new file was created - check if it has a label
    console.debug(`File created: ${uri.fsPath}, checking label`);
    await provider.updateLabel(uri);
  });

  watcher.onDidDelete(async (uri) => {
    // A file was deleted - remove from cache
    console.debug(`File deleted: ${uri.fsPath}, invalidating cache`);
    provider.invalidateCache(uri);
  });

  context.subscriptions.push(watcher);

  // Also set up a more comprehensive watcher for the workspace root
  const workspaceWatcher = vscode.workspace.createFileSystemWatcher(
    '{**/*.*,**/.*}', // Watch all files including hidden
    true, // Watch subdirectories
    false,
    false
  );

  workspaceWatcher.onDidChange(refreshAll);
  workspaceWatcher.onDidCreate(refreshAll);
  workspaceWatcher.onDidDelete(refreshAll);

  context.subscriptions.push(workspaceWatcher);
}
