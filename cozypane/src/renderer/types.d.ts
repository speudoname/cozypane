export {};

declare global {
  const __APP_VERSION__: string;
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

  interface DeployAuth {
    authenticated: boolean;
    username?: string;
    avatarUrl?: string;
  }

  interface ProjectDetection {
    type: 'node' | 'python' | 'go' | 'static' | 'docker' | 'unknown';
    name: string;
  }

  interface Deployment {
    id: number;
    appName: string;
    subdomain: string;
    status: 'building' | 'running' | 'stopped' | 'error';
    projectType: string;
    tier: string;
    url: string;
    createdAt: string;
    updatedAt: string;
  }

  interface ConversationTurn {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }

  interface GitCommit {
    hash: string;
    message: string;
    timeAgo: string;
  }

  interface CozyPaneAPI {
    getPathForFile: (file: File) => string;
    terminal: {
      write: (id: string, data: string) => void;
      resize: (id: string, cols: number, rows: number) => void;
      onData: (callback: (id: string, data: string) => void) => () => void;
      onExit: (callback: (id: string, code: number) => void) => () => void;
      create: (cwd?: string) => Promise<{ id: string; cwd: string }>;
      close: (id: string) => Promise<void>;
      getCwd: (id: string) => Promise<string | null>;
    };
    fs: {
      readdir: (dirPath: string) => Promise<FileEntry[]>;
      readfile: (filePath: string) => Promise<FileContent>;
      readBinary: (filePath: string) => Promise<{ base64?: string; mime?: string; size?: number; error?: string }>;
      writefile: (filePath: string, content: string) => Promise<{ success?: boolean; error?: string }>;
      homedir: () => Promise<string>;
      pickFile: () => Promise<{ paths: string[] }>;
      saveClipboardImage: () => Promise<{ path: string | null }>;
      clipboardFilePaths: () => Promise<{ paths: string[] }>;
      getSlashCommands: (cwd?: string) => Promise<{ cmd: string; desc: string; source: string }[]>;
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
    deploy: {
      login: () => Promise<void>;
      logout: () => Promise<void>;
      getAuth: () => Promise<DeployAuth>;
      detectProject: (cwd: string) => Promise<ProjectDetection>;
      start: (cwd: string, appName: string, tier?: string) => Promise<Deployment>;
      list: () => Promise<Deployment[]>;
      get: (id: string) => Promise<Deployment>;
      logs: (id: string) => Promise<string>;
      delete: (id: string) => Promise<{ success: boolean }>;
      redeploy: (id: string) => Promise<Deployment>;
      onProtocolCallback: (callback: (url: string) => void) => () => void;
    };
    onMenuAction: (channel: string, callback: () => void) => () => void;
    git: {
      isRepo: (cwd: string) => Promise<{ isRepo: boolean }>;
      status: (cwd: string) => Promise<{ files: GitFileStatus[]; error?: string }>;
      branch: (cwd: string) => Promise<{ branch: string; detached: boolean }>;
      log: (cwd: string) => Promise<{ commits: GitCommit[] }>;
      diffFile: (cwd: string, path: string) => Promise<{ before?: string; after?: string; error?: string }>;
      remoteInfo: (cwd: string) => Promise<{ hasRemote: boolean; remoteUrl: string; ghAuthed: boolean; ghInstalled: boolean }>;
      generateCommitMsg: (cwd: string) => Promise<{ message?: string; error?: string }>;
    };
  }

  interface Window {
    cozyPane: CozyPaneAPI;
  }
}
