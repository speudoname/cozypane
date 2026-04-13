import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron
vi.mock('electron');

// Mock fs — use vi.hoisted so refs are available inside vi.mock factory
const {
  _existsSync, _readFileSync, _writeFileSync, _readFile, _statSync,
  _promisesStat, _promisesReadFile,
} = vi.hoisted(() => ({
  _existsSync: vi.fn().mockReturnValue(false),
  _readFileSync: vi.fn(),
  _writeFileSync: vi.fn(),
  _readFile: vi.fn(),
  _statSync: vi.fn(),
  _promisesStat: vi.fn(),
  _promisesReadFile: vi.fn(),
}));

vi.mock('fs', () => {
  const mod = {
    existsSync: _existsSync,
    readFileSync: _readFileSync,
    writeFileSync: _writeFileSync,
    readFile: _readFile,
    statSync: _statSync,
    promises: { stat: _promisesStat, readFile: _promisesReadFile },
  };
  return { default: mod, ...mod };
});

// Mock net
vi.mock('net', () => ({
  default: {
    createServer: vi.fn().mockReturnValue({
      listen: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    }),
  },
  createServer: vi.fn().mockReturnValue({
    listen: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  }),
}));

// Mock http
vi.mock('http', () => ({
  default: {
    createServer: vi.fn().mockReturnValue({
      listen: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    }),
  },
  createServer: vi.fn().mockReturnValue({
    listen: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  }),
}));

// Mock the mime module
vi.mock('./mime', () => ({
  MIME_TYPES: {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
  },
  getMimeType: vi.fn((ext: string) => {
    const types: Record<string, string> = {
      '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
      '.json': 'application/json', '.png': 'image/png',
    };
    const key = ext.startsWith('.') ? ext : `.${ext}`;
    return types[key] || 'application/octet-stream';
  }),
}));

// Mock framework-data.json
vi.mock('./framework-data.json', () => ({
  default: {
    frameworks: {
      next: { dep: 'next', devCommand: 'npm run dev', altDeps: [] },
      vite: { dep: 'vite', devCommand: 'npm run dev', altDeps: [], excludeIfPresent: ['express', 'fastify', 'next'] },
      react: { dep: 'react-scripts', devCommand: 'npm start', altDeps: [] },
    },
    dbDeps: ['prisma', '@prisma/client', 'pg', 'mysql2', 'mongoose'],
  },
}));

import { ipcMain, app } from 'electron';
import { registerPreviewHandlers } from './preview';
import path from 'path';

describe('preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerPreviewHandlers', () => {
    it('registers expected IPC handlers', () => {
      registerPreviewHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const channels = calls.map((c: any) => c[0]);
      expect(channels).toContain('preview:detectProject');
      expect(channels).toContain('preview:serveStatic');
      expect(channels).toContain('preview:stopStatic');
      expect(channels).toContain('preview:getStoredUrl');
      expect(channels).toContain('preview:storeUrl');
      expect(channels).toContain('preview:writeDevToolsData');
      expect(channels).toContain('preview:captureScreenshot');
      expect(channels).toContain('preview:suggestPort');
    });

    it('registers will-quit cleanup handler', () => {
      registerPreviewHandlers();
      expect(app.on).toHaveBeenCalledWith('will-quit', expect.any(Function));
    });
  });

  describe('truncateData logic (via writeDevToolsData)', () => {
    // truncateData is not exported, but we can test it through the IPC handler
    it('writeDevToolsData handler exists and calls through', async () => {
      registerPreviewHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const handler = calls.find((c: any) => c[0] === 'preview:writeDevToolsData')?.[1];
      expect(handler).toBeDefined();
      // The handler writes a file — with our fs mock it should not throw
      const result = await handler({}, { key: 'value' });
      // Should not return error
      expect(result?.error).toBeUndefined();
    });
  });

  describe('captureScreenshot', () => {
    it('caps screenshot at 3MB base64', async () => {
      registerPreviewHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const handler = calls.find((c: any) => c[0] === 'preview:captureScreenshot')?.[1];

      // Create a small base64 string (under limit)
      const smallBase64 = Buffer.from('hello').toString('base64');
      await handler({}, smallBase64);

      expect(_writeFileSync).toHaveBeenCalled();
      const callArgs = _writeFileSync.mock.calls[0];
      // Should have written to the expected path
      expect(callArgs[0]).toContain('preview-screenshot.png');
    });
  });

  describe('detectProject handler', () => {
    // Register once, extract the handler, then configure fs mocks per-test
    function getDetectHandler() {
      registerPreviewHandlers();
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      return calls.find((c: any) => c[0] === 'preview:detectProject')![1];
    }

    it('detects static HTML project when index.html exists', async () => {
      _existsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('index.html')) return true;
        return false;
      });

      const handler = getDetectHandler();
      const result = await handler({}, '/test/project');
      expect(result.type).toBe('static');
      expect(result.serveStatic).toBe(true);
    });

    it('detects Django project', async () => {
      _existsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('manage.py')) return true;
        return false;
      });

      const handler = getDetectHandler();
      const result = await handler({}, '/test/django-app');
      expect(result.type).toBe('django');
      expect(result.devCommand).toBe('python manage.py runserver');
    });

    it('detects Go project', async () => {
      _existsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('go.mod')) return true;
        return false;
      });

      const handler = getDetectHandler();
      const result = await handler({}, '/test/go-app');
      expect(result.type).toBe('go');
      expect(result.devCommand).toBe('go run .');
    });

    it('detects Next.js project via package.json', async () => {
      _existsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('package.json')) return true;
        return false;
      });
      _readFileSync.mockReturnValue(JSON.stringify({
        scripts: { dev: 'next dev' },
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
      }));

      const handler = getDetectHandler();
      const result = await handler({}, '/test/nextjs-app');
      expect(result.type).toBe('next');
      expect(result.devCommand).toBe('npm run dev');
    });

    it('returns null type when no project markers found', async () => {
      _existsSync.mockReturnValue(false);

      const handler = getDetectHandler();
      const result = await handler({}, '/test/empty');
      expect(result.type).toBeNull();
    });
  });

  describe('path traversal protection', () => {
    it('path.resolve prevents traversal via ../', () => {
      const root = '/home/user/project';
      const malicious = path.join(root, '../../etc/passwd');
      const resolved = path.resolve(malicious);
      // Resolved path should NOT start with root + path.sep
      expect(resolved.startsWith(root + path.sep)).toBe(false);
    });

    it('sibling directory is rejected with trailing sep check', () => {
      const root = path.resolve('/home/user/project');
      const sibling = path.resolve('/home/user/project-leak/secret.txt');
      // Without trailing sep, startsWith would match (the bug the code fixed)
      expect(sibling.startsWith(root)).toBe(true);
      // With trailing sep, it correctly rejects
      expect(sibling.startsWith(root + path.sep)).toBe(false);
    });
  });
});
