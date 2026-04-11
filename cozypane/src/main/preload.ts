import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('cozyPane', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  terminal: {
    write: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
    onData: (callback: (id: string, data: string) => void) => {
      const listener = (_event: any, id: string, data: string) => callback(id, data);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    onExit: (callback: (id: string, code: number) => void) => {
      const listener = (_event: any, id: string, code: number) => callback(id, code);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    },
    create: (cwd?: string) => ipcRenderer.invoke('terminal:create', cwd),
    close: (id: string) => ipcRenderer.invoke('terminal:close', id),
    getCwd: (id: string) => ipcRenderer.invoke('terminal:getCwd', id),
  },
  fs: {
    readdir: (dirPath: string) => ipcRenderer.invoke('fs:readdir', dirPath),
    readfile: (filePath: string) => ipcRenderer.invoke('fs:readfile', filePath),
    writefile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writefile', filePath, content),
    readBinary: (filePath: string) => ipcRenderer.invoke('fs:readBinary', filePath),
    homedir: () => ipcRenderer.invoke('fs:homedir'),
    pickFile: () => ipcRenderer.invoke('fs:pickFile'),
    pickDirectory: () => ipcRenderer.invoke('fs:pickDirectory'),
    mkdir: (dirPath: string) => ipcRenderer.invoke('fs:mkdir', dirPath),
    unlink: (filePath: string) => ipcRenderer.invoke('fs:unlink', filePath),
    rmdir: (dirPath: string) => ipcRenderer.invoke('fs:rmdir', dirPath),
    rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
    saveClipboardImage: () => ipcRenderer.invoke('fs:saveClipboardImage'),
    clipboardFilePaths: () => ipcRenderer.invoke('fs:clipboardFilePaths'),
    getSlashCommands: (cwd?: string) => ipcRenderer.invoke('fs:getSlashCommands', cwd),
  },
  watcher: {
    start: (dirPath: string) => ipcRenderer.invoke('watcher:start', dirPath),
    stop: () => ipcRenderer.invoke('watcher:stop'),
    onChange: (callback: (event: any) => void) => {
      const listener = (_event: any, data: any) => callback(data);
      ipcRenderer.on('watcher:change', listener);
      return () => ipcRenderer.removeListener('watcher:change', listener);
    },
    getDiff: (filePath: string) => ipcRenderer.invoke('watcher:getDiff', filePath),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (data: { provider: string; model: string; apiKey?: string }) => ipcRenderer.invoke('settings:set', data),
    setDefaultDir: (dir: string) => ipcRenderer.invoke('settings:setDefaultDir', dir),
  },
  deploy: {
    login: () => ipcRenderer.invoke('deploy:login'),
    logout: () => ipcRenderer.invoke('deploy:logout'),
    getAuth: () => ipcRenderer.invoke('deploy:getAuth'),
    detectProject: (cwd: string) => ipcRenderer.invoke('deploy:detectProject', cwd),
    start: (cwd: string, appName: string, tier?: string) => ipcRenderer.invoke('deploy:start', cwd, appName, tier),
    list: () => ipcRenderer.invoke('deploy:list'),
    get: (id: string) => ipcRenderer.invoke('deploy:get', id),
    logs: (id: string) => ipcRenderer.invoke('deploy:logs', id),
    delete: (id: string) => ipcRenderer.invoke('deploy:delete', id),
    redeploy: (id: string) => ipcRenderer.invoke('deploy:redeploy', id),
    addDomain: (deployId: string, domain: string) => ipcRenderer.invoke('deploy:addDomain', deployId, domain),
    verifyDomain: (deployId: string, domainId: string) => ipcRenderer.invoke('deploy:verifyDomain', deployId, domainId),
    removeDomain: (deployId: string, domainId: string) => ipcRenderer.invoke('deploy:removeDomain', deployId, domainId),
    listDomains: (deployId: string) => ipcRenderer.invoke('deploy:listDomains', deployId),
    onProtocolCallback: (callback: (url: string) => void) => {
      const listener = (_event: any, url: string) => callback(url);
      ipcRenderer.on('deploy:protocol-callback', listener);
      return () => ipcRenderer.removeListener('deploy:protocol-callback', listener);
    },
  },
  preview: {
    detectProject: (cwd: string) => ipcRenderer.invoke('preview:detectProject', cwd),
    serveStatic: (cwd: string) => ipcRenderer.invoke('preview:serveStatic', cwd),
    stopStatic: (cwd: string) => ipcRenderer.invoke('preview:stopStatic', cwd),
    getStoredUrl: (cwd: string) => ipcRenderer.invoke('preview:getStoredUrl', cwd),
    storeUrl: (cwd: string, data: { productionUrl?: string; lastDevCommand?: string }) => ipcRenderer.invoke('preview:storeUrl', cwd, data),
    writeDevToolsData: (data: object) => ipcRenderer.invoke('preview:writeDevToolsData', data),
    captureScreenshot: (base64Png: string) => ipcRenderer.invoke('preview:captureScreenshot', base64Png),
    suggestPort: (preferredPort?: number) => ipcRenderer.invoke('preview:suggestPort', preferredPort),
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    getLast: () => ipcRenderer.invoke('updates:getLast'),
    getCommand: (opts: { brew: boolean; claude: boolean }) => ipcRenderer.invoke('updates:getCommand', opts),
    onAvailable: (callback: (info: any) => void) => {
      const listener = (_event: any, info: any) => callback(info);
      ipcRenderer.on('updates:available', listener);
      return () => ipcRenderer.removeListener('updates:available', listener);
    },
  },
  onMenuAction: (channel: string, callback: (...args: any[]) => void) => {
    const ALLOWED_CHANNELS = new Set([
      'menu:new-tab', 'menu:close-tab', 'menu:toggle-panels', 'menu:toggle-layout',
      'menu:settings', 'menu:clear-terminal', 'menu:split-view',
      'menu:zoom-in', 'menu:zoom-out', 'menu:zoom-reset',
      'updater:status', 'updates:available', 'deploy:auth-success', 'deploy:auth-error', 'github:auth-changed',
    ]);
    if (!ALLOWED_CHANNELS.has(channel)) return () => {};
    const listener = (_event: any, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  mcp: {
    getConfigPath: () => ipcRenderer.invoke('mcp:getConfigPath'),
  },
  git: {
    isRepo: (cwd: string) => ipcRenderer.invoke('git:isRepo', cwd),
    status: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
    branch: (cwd: string) => ipcRenderer.invoke('git:branch', cwd),
    log: (cwd: string) => ipcRenderer.invoke('git:log', cwd),
    diffFile: (cwd: string, path: string) => ipcRenderer.invoke('git:diffFile', cwd, path),
    remoteInfo: (cwd: string) => ipcRenderer.invoke('git:remoteInfo', cwd),
    generateCommitMsg: (cwd: string) => ipcRenderer.invoke('git:generateCommitMsg', cwd),
    wrapCommand: (cmd: string) => ipcRenderer.invoke('git:wrapCommand', cmd),
    createRepo: (cwd: string, isPrivate?: boolean) => ipcRenderer.invoke('git:createRepo', cwd, isPrivate),
    listRepos: (query: string) => ipcRenderer.invoke('git:listRepos', query),
    addRemote: (cwd: string, cloneUrl: string) => ipcRenderer.invoke('git:addRemote', cwd, cloneUrl),
  },
});
