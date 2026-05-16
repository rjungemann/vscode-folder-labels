import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { ColorIndex } from './types';

type ResponseCallback = (response: Record<string, unknown>) => void;

export class HelperClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<number, ResponseCallback>();
  private nextId = 1;
  private startPromise: Promise<void> | null = null;
  private _available = true;

  private binaryPath(): string {
    return path.join(__dirname, '..', 'bin', 'folder-labels-helper');
  }

  private async ensureStarted(): Promise<void> {
    if (!this._available) { throw new Error('helper binary not available'); }
    if (this.proc && !this.proc.killed) { return; }
    if (this.startPromise) { return this.startPromise; }
    this.startPromise = this.start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const proc = spawn(this.binaryPath(), [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;

      proc.on('error', (err: NodeJS.ErrnoException) => {
        this.proc = null;
        if (err.code === 'ENOENT' || err.code === 'EACCES') { this._available = false; }
        // Reject all in-flight requests
        for (const cb of this.pending.values()) {
          cb({ error: `helper process error: ${err.message}` });
        }
        this.pending.clear();
        if (!resolved) { reject(err); }
      });

      proc.on('exit', () => { this.proc = null; });

      proc.stderr.on('data', (data: Buffer) => {
        console.error('[Folder Labels helper]', data.toString().trim());
      });

      this.rl?.close();
      this.rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      this.rl.on('line', (line: string) => {
        try {
          const response = JSON.parse(line) as { id?: number };
          if (typeof response.id === 'number') {
            const cb = this.pending.get(response.id);
            if (cb) {
              this.pending.delete(response.id);
              cb(response as Record<string, unknown>);
            }
          }
        } catch { /* ignore malformed lines */ }
      });

      this.proc = proc;
      resolved = true;
      resolve();
    });
  }

  private send(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.ensureStarted();
      } catch (err) {
        reject(err);
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, (response) => {
        if (response['error']) {
          reject(new Error(String(response['error'])));
        } else {
          resolve(response);
        }
      });
      this.proc!.stdin.write(JSON.stringify({ ...request, id }) + '\n');
    });
  }

  async readBatch(paths: string[]): Promise<Map<string, ColorIndex>> {
    if (paths.length === 0) { return new Map(); }
    const response = await this.send({ op: 'read', paths });
    const results = response['results'] as Array<{ path: string; colorIndex: number | null }> | undefined;
    const map = new Map<string, ColorIndex>();
    for (const r of results ?? []) {
      if (r.colorIndex !== null && r.colorIndex !== undefined) {
        map.set(r.path, r.colorIndex as ColorIndex);
      }
    }
    return map;
  }

  async read(filePath: string): Promise<ColorIndex | undefined> {
    const map = await this.readBatch([filePath]);
    return map.get(filePath);
  }

  async write(filePath: string, colorIndex: ColorIndex): Promise<void> {
    await this.send({ op: 'write', path: filePath, colorIndex });
  }

  async clear(filePath: string): Promise<void> {
    await this.send({ op: 'clear', path: filePath });
  }

  get available(): boolean { return this._available; }

  dispose(): void {
    this.rl?.close();
    this.rl = null;
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
    for (const cb of this.pending.values()) {
      cb({ error: 'helper disposed' });
    }
    this.pending.clear();
  }
}
