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
    defaultProjectDir: string;
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

  // --- Shared preview / terminal-tab types ---
  // These used to live inside components/TerminalTabBar.tsx and were imported
  // by Preview.tsx and App.tsx via `import type { ... } from './TerminalTabBar'`.
  // Moving them into the global ambient types stops a leaf component from
  // owning domain types that cross feature boundaries.

  interface PreviewError {
    type: 'console' | 'network' | 'load';
    message: string;
    timestamp: number;
    detail?: string;
  }

  interface ConsoleLog {
    level: number;
    message: string;
    timestamp: number;
    source?: string;
    line?: number;
  }

  interface NetworkRequest {
    method: string;
    url: string;
    status: number;
    statusText: string;
    duration: number;
    size?: number;
    timestamp: number;
    ok: boolean;
  }

  interface NetworkError {
    method: string;
    url: string;
    status: number;
    statusText: string;
    timestamp: number;
  }

  type AiAction = 'idle' | 'reading' | 'writing' | 'executing' | 'thinking';

  interface TerminalError {
    type: 'typescript' | 'build' | 'runtime' | 'warning' | 'hmr';
    message: string;
    file?: string;
    line?: number;
    timestamp: number;
  }

  interface DevServerState {
    status: 'running' | 'error' | 'starting' | 'stopped';
    url: string | null;
    hasErrors: boolean;
    errorSummary: string;
    errors: TerminalError[];
    recentOutput: string[];
    timestamp: number;
  }

  interface TerminalTab {
    id: string;
    ptyId: string | null;
    label: string;
    customLabel?: string;
    cwd: string;
    aiAction: AiAction;
    claudeRunning: boolean;
    launched: boolean;
    autoCommand?: string;
    previewLocalUrl?: string;
    previewLocalUrls?: string[];
    previewProdUrl?: string;
    previewErrors?: PreviewError[];
    previewConsoleLogs?: ConsoleLog[];
    previewNetworkErrors?: NetworkError[];
    devServerAutoOpened?: boolean;
    devServerState?: DevServerState;
    isDevServer?: boolean;
  }

  interface CustomDomain {
    id: number;
    domain: string;
    verified: boolean;
    cname: string;
    createdAt?: string;
  }

  interface Deployment {
    id: number;
    appName: string;
    subdomain: string;
    status: 'building' | 'running' | 'stopped' | 'error' | 'failed' | 'unhealthy';
    projectType: string;
    tier: string;
    url: string;
    hasDatabase?: boolean;
    databaseType?: 'postgres' | 'redis' | 'mysql' | null;
    databaseName?: string | null;
    group?: string | null;
    framework?: string | null;
    customDomains?: CustomDomain[];
    createdAt: string;
    updatedAt: string;
  }

  interface GitHubRepo {
    fullName: string;
    cloneUrl: string;
    htmlUrl: string;
    private: boolean;
    description: string;
  }

  interface GitCommit {
    hash: string;
    message: string;
    timeAgo: string;
  }

  // (SubProject interface removed — audit L29. Was referenced only by the
  // `subProjects?` field on ProjectInfo, which itself had zero runtime
  // users.)

  interface ProjectInfo {
    type: string | null;
    devCommand: string | null;
    productionUrl: string | null;
    serveStatic?: boolean;
    needsDatabase?: boolean;
  }

  interface UpdateInfo {
    brewOutdated: { name: string; current: string; latest: string }[];
    claudeUpdate: { current: string; latest: string } | null;
    checkedAt: number;
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
      unlink: (filePath: string) => Promise<{ success?: boolean; error?: string }>;
      rmdir: (dirPath: string) => Promise<{ success?: boolean; error?: string }>;
      rename: (oldPath: string, newPath: string) => Promise<{ success?: boolean; error?: string }>;
      homedir: () => Promise<string>;
      pickFile: () => Promise<{ paths: string[] }>;
      pickDirectory: () => Promise<{ paths: string[] }>;
      mkdir: (dirPath: string) => Promise<{ success?: boolean; error?: string }>;
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
      setDefaultDir: (dir: string) => Promise<{ success?: boolean; error?: string }>;
    };
    deploy: {
      login: () => Promise<void>;
      logout: () => Promise<void>;
      getAuth: () => Promise<DeployAuth>;
      list: () => Promise<Deployment[]>;
      logs: (id: string) => Promise<string>;
      delete: (id: string) => Promise<{ success: boolean }>;
      redeploy: (id: string) => Promise<Deployment>;
      addDomain: (deployId: string, domain: string) => Promise<{ success?: boolean; error?: string }>;
      verifyDomain: (deployId: string, domainId: string) => Promise<{ success?: boolean; verified?: boolean; error?: string }>;
      removeDomain: (deployId: string, domainId: string) => Promise<{ success?: boolean; error?: string }>;
      listDomains: (deployId: string) => Promise<{ domains?: CustomDomain[]; error?: string }>;
      databaseInfo: (deployId: string) => Promise<{ exists: boolean; name?: string; size?: string; tables?: Array<{ name: string; rowCount: number; size: string }>; error?: string }>;
      infrastructure: () => Promise<{ postgres: { status: string; version?: string; databases: number; totalSize?: string }; redis: { status: string; keys?: number; memory?: string }; error?: string }>;
      onProtocolCallback: (callback: (url: string) => void) => () => void;
      onAuthSuccess: (callback: (payload: { username: string; avatarUrl: string }) => void) => () => void;
      onAuthError: (callback: (payload: { error: string }) => void) => () => void;
    };
    preview: {
      detectProject: (cwd: string) => Promise<ProjectInfo>;
      serveStatic: (cwd: string) => Promise<{ url?: string; port?: number; error?: string }>;
      stopStatic: (cwd: string) => Promise<{ success?: boolean }>;
      getStoredUrl: (cwd: string) => Promise<{ productionUrl?: string; lastDevCommand?: string }>;
      storeUrl: (cwd: string, data: { productionUrl?: string; lastDevCommand?: string }) => Promise<{ success?: boolean }>;
      writeDevToolsData: (data: object) => Promise<void>;
      captureScreenshot: (base64Png: string) => Promise<string>;
      suggestPort: (preferredPort?: number) => Promise<{ port: number }>;
      writeDevServerState: (data: object) => Promise<void>;
      writeInspectData: (data: object) => Promise<void>;
    };
    updates: {
      check: () => Promise<UpdateInfo>;
      getLast: () => Promise<UpdateInfo | null>;
      getCommand: (opts: { brew: boolean; claude: boolean }) => Promise<string>;
      onAvailable: (callback: (info: UpdateInfo) => void) => () => void;
      onStatus: (callback: (info: { status: string; version?: string }) => void) => () => void;
      onError: (callback: (info: { message: string }) => void) => () => void;
    };
    onMenuAction: (channel: string, callback: (...args: any[]) => void) => () => void;
    chat: {
      formatResponse: (rawOutput: string) => Promise<{ text?: string; error?: string }>;
    };
    mcp: {
      getConfigPath: () => Promise<{ path?: string; error?: string }>;
    };
    git: {
      isRepo: (cwd: string) => Promise<{ isRepo: boolean }>;
      status: (cwd: string) => Promise<{ files: GitFileStatus[]; error?: string }>;
      branch: (cwd: string) => Promise<{ branch: string; detached: boolean }>;
      log: (cwd: string) => Promise<{ commits: GitCommit[] }>;
      diffFile: (cwd: string, path: string) => Promise<{ before?: string; after?: string; error?: string }>;
      remoteInfo: (cwd: string) => Promise<{ hasRemote: boolean; remoteUrl: string; githubAuthed: boolean; isSSH: boolean }>;
      generateCommitMsg: (cwd: string) => Promise<{ message?: string; error?: string }>;
      wrapCommand: (cmd: string) => Promise<string>;
      createRepo: (cwd: string, isPrivate?: boolean) => Promise<{ url?: string; cloneUrl?: string; fullName?: string; error?: string }>;
      listRepos: (query: string) => Promise<{ repos: GitHubRepo[]; error?: string }>;
      addRemote: (cwd: string, cloneUrl: string) => Promise<{ success?: boolean; error?: string }>;
      onAuthChanged: (callback: (payload: { username: string; avatarUrl: string }) => void) => () => void;
    };
  }

  interface Window {
    cozyPane: CozyPaneAPI;
  }
}
