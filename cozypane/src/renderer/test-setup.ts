import '@testing-library/jest-dom';

// Mock the preload bridge
Object.defineProperty(window, 'cozyPane', {
  value: {
    terminal: {
      create: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      getCwd: vi.fn(),
      close: vi.fn(),
    },
    fs: {
      readdir: vi.fn(),
      readfile: vi.fn(),
      writefile: vi.fn(),
      homedir: vi.fn().mockResolvedValue('/Users/test'),
      pickFile: vi.fn(),
      pickDirectory: vi.fn(),
      mkdir: vi.fn(),
      unlink: vi.fn(),
      rmdir: vi.fn(),
      rename: vi.fn(),
      getSlashCommands: vi.fn().mockResolvedValue([]),
    },
    watcher: {
      start: vi.fn(),
      stop: vi.fn(),
      onChange: vi.fn(),
      getDiff: vi.fn(),
    },
    settings: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn(),
      setDefaultDir: vi.fn(),
    },
    deploy: {
      login: vi.fn(),
      logout: vi.fn(),
      getAuth: vi.fn(),
      list: vi.fn(),
    },
    preview: {
      detectProject: vi.fn(),
      serveStatic: vi.fn(),
      stopStatic: vi.fn(),
    },
    updates: {
      check: vi.fn(),
      getLast: vi.fn(),
    },
    git: {
      isRepo: vi.fn(),
      status: vi.fn(),
      branch: vi.fn(),
    },
    mcp: {
      getConfigPath: vi.fn(),
    },
    onMenuAction: vi.fn(),
  },
  writable: true,
});
