import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron
vi.mock('electron');

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock filesystem module (the project's own module)
vi.mock('./filesystem', () => ({
  isPathAllowed: vi.fn().mockReturnValue(true),
  addAllowedRoot: vi.fn(),
}));

// Mock windows module
vi.mock('./windows', () => ({
  safeSend: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => {
  const watchers: any[] = [];
  return {
    default: {
      watch: vi.fn().mockImplementation(() => {
        const watcher = {
          close: vi.fn(),
          on: vi.fn(),
          _callback: null as any,
        };
        watchers.push(watcher);
        return watcher;
      }),
      promises: {
        stat: vi.fn().mockResolvedValue({ isDirectory: () => false, size: 100 }),
        readFile: vi.fn().mockResolvedValue('file content'),
      },
      readFileSync: vi.fn(),
    },
    watch: vi.fn().mockImplementation(() => {
      const watcher = {
        close: vi.fn(),
        on: vi.fn(),
        _callback: null as any,
      };
      watchers.push(watcher);
      return watcher;
    }),
    promises: {
      stat: vi.fn().mockResolvedValue({ isDirectory: () => false, size: 100 }),
      readFile: vi.fn().mockResolvedValue('file content'),
    },
    readFileSync: vi.fn(),
    __getWatchers: () => watchers,
  };
});

import { ipcMain } from 'electron';
import { registerWatcherHandlers, closeWatcher } from './watcher';
import { isPathAllowed } from './filesystem';

describe('watcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerWatcherHandlers', () => {
    it('registers expected IPC handlers', () => {
      registerWatcherHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const channels = calls.map((c: any) => c[0]);
      expect(channels).toContain('watcher:start');
      expect(channels).toContain('watcher:stop');
      expect(channels).toContain('watcher:getDiff');
    });

    it('watcher:start rejects paths not in allowlist', async () => {
      (isPathAllowed as ReturnType<typeof vi.fn>).mockReturnValue(false);

      registerWatcherHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const startHandler = calls.find((c: any) => c[0] === 'watcher:start')?.[1];

      const result = await startHandler({ sender: { isDestroyed: () => false } }, '/forbidden/path');
      expect(result).toEqual({ error: 'Watcher path is not in the project allowlist' });
    });

    it('watcher:start succeeds for allowed paths', async () => {
      (isPathAllowed as ReturnType<typeof vi.fn>).mockReturnValue(true);

      registerWatcherHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const startHandler = calls.find((c: any) => c[0] === 'watcher:start')?.[1];

      const result = await startHandler({ sender: { isDestroyed: () => false } }, '/allowed/project');
      expect(result).toEqual({ success: true });
    });

    it('watcher:stop returns success', async () => {
      registerWatcherHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const stopHandler = calls.find((c: any) => c[0] === 'watcher:stop')?.[1];

      const result = await stopHandler();
      expect(result).toEqual({ success: true });
    });

    it('watcher:getDiff rejects paths not in allowlist', async () => {
      registerWatcherHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const getDiffHandler = calls.find((c: any) => c[0] === 'watcher:getDiff')?.[1];

      // Mock isPathAllowed to return false for the getDiff call
      (isPathAllowed as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = await getDiffHandler({}, '/some/file.ts');
      expect(result).toEqual({ error: 'Path not in project allowlist' });
    });

    it('watcher:getDiff returns error when no snapshot available', async () => {
      (isPathAllowed as ReturnType<typeof vi.fn>).mockReturnValue(true);

      registerWatcherHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const getDiffHandler = calls.find((c: any) => c[0] === 'watcher:getDiff')?.[1];

      const result = await getDiffHandler({}, '/some/file.ts');
      expect(result).toEqual({ error: 'No snapshot available for this file' });
    });
  });

  describe('ignore patterns', () => {
    // Test the ignore patterns used by the watcher by examining the regex directly
    // These patterns are defined at module scope, so we test the same logic

    const IGNORE_PATTERN = /^(Library|Applications|Pictures|Music|Movies|Public|Downloads|\.Trash|\.cache|\.npm|\.nvm|\.local|\.config|\.docker|\.vscode|\.cursor|Containers)[/\\]/i;
    const IGNORE_INNER = /(node_modules|__pycache__|\.git)[/\\]/;
    const IGNORE_EXT = /\.(swp|tmp|pyc|DS_Store)$|~$/;

    it('ignores node_modules paths', () => {
      expect(IGNORE_INNER.test('node_modules/package/index.js')).toBe(true);
    });

    it('ignores .git paths', () => {
      expect(IGNORE_INNER.test('.git/objects/abc')).toBe(true);
    });

    it('ignores __pycache__ paths', () => {
      expect(IGNORE_INNER.test('__pycache__/module.pyc')).toBe(true);
    });

    it('ignores .swp files', () => {
      expect(IGNORE_EXT.test('file.swp')).toBe(true);
    });

    it('ignores .tmp files', () => {
      expect(IGNORE_EXT.test('temp.tmp')).toBe(true);
    });

    it('ignores .DS_Store files', () => {
      expect(IGNORE_EXT.test('.DS_Store')).toBe(true);
    });

    it('ignores backup files ending with ~', () => {
      expect(IGNORE_EXT.test('file.ts~')).toBe(true);
    });

    it('ignores Library directory', () => {
      expect(IGNORE_PATTERN.test('Library/Caches/something')).toBe(true);
    });

    it('ignores .cache directory', () => {
      expect(IGNORE_PATTERN.test('.cache/something')).toBe(true);
    });

    it('ignores .vscode directory', () => {
      expect(IGNORE_PATTERN.test('.vscode/settings.json')).toBe(true);
    });

    it('does not ignore regular project files', () => {
      expect(IGNORE_PATTERN.test('src/main.ts')).toBe(false);
      expect(IGNORE_INNER.test('src/main.ts')).toBe(false);
      expect(IGNORE_EXT.test('src/main.ts')).toBe(false);
    });
  });

  describe('closeWatcher', () => {
    it('can be called without error when no watcher active', () => {
      expect(() => closeWatcher()).not.toThrow();
    });
  });
});
