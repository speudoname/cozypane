interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
}

interface FileContent {
  content?: string;
  error?: string;
  size?: number;
}

interface FileChangeEvent {
  type: 'create' | 'modify' | 'delete';
  path: string;
  name: string;
  isDirectory: boolean;
  timestamp: number;
}

interface DiffResult {
  before?: string;
  after?: string;
  error?: string;
}

interface SettingsData {
  provider: string;
  model: string;
  hasApiKey: boolean;
  providers: Record<string, { name: string; models: { id: string; name: string }[] }>;
}

interface GitFileStatus {
  path: string;
  indexStatus: string;
  workStatus: string;
  staged: boolean;
  status: 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed';
}

interface GitCommit {
  hash: string;
  message: string;
  timeAgo: string;
}

interface CozyPaneAPI {
  terminal: {
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    onData: (callback: (data: string) => void) => () => void;
    onExit: (callback: (code: number) => void) => () => void;
    create: (cwd?: string) => Promise<string>;
    getCwd: () => Promise<string | null>;
  };
  fs: {
    readdir: (dirPath: string) => Promise<FileEntry[]>;
    readfile: (filePath: string) => Promise<FileContent>;
    writefile: (filePath: string, content: string) => Promise<{ success?: boolean; error?: string }>;
    homedir: () => Promise<string>;
  };
  watcher: {
    start: (dirPath: string) => Promise<{ success?: boolean; error?: string }>;
    stop: () => Promise<{ success?: boolean }>;
    onChange: (callback: (event: FileChangeEvent) => void) => () => void;
    getDiff: (filePath: string) => Promise<DiffResult>;
  };
  settings: {
    get: () => Promise<SettingsData>;
    set: (data: { provider: string; model: string; apiKey?: string }) => Promise<{ success?: boolean; error?: string }>;
    summarize: (changes: { type: string; name: string }[]) => Promise<{ summary?: string; error?: string }>;
  };
  git: {
    isRepo: (cwd: string) => Promise<{ isRepo: boolean }>;
    status: (cwd: string) => Promise<{ files: GitFileStatus[]; error?: string }>;
    branch: (cwd: string) => Promise<{ branch: string; detached: boolean }>;
    log: (cwd: string) => Promise<{ commits: GitCommit[] }>;
    stage: (cwd: string, path: string) => Promise<{ success: boolean; error?: string }>;
    unstage: (cwd: string, path: string) => Promise<{ success: boolean; error?: string }>;
    stageAll: (cwd: string) => Promise<{ success: boolean; error?: string }>;
    unstageAll: (cwd: string) => Promise<{ success: boolean; error?: string }>;
    commit: (cwd: string, message: string) => Promise<{ success: boolean; hash?: string; error?: string }>;
    diffFile: (cwd: string, path: string) => Promise<{ before?: string; after?: string; error?: string }>;
    revertFile: (cwd: string, path: string) => Promise<{ success: boolean; error?: string }>;
    revertFiles: (cwd: string, paths: string[]) => Promise<{ success: boolean; error?: string }>;
  };
}

declare global {
  interface Window {
    cozyPane: CozyPaneAPI;
  }
}

export {};
