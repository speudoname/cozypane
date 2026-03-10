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
    saveClipboardImage: () => ipcRenderer.invoke('fs:saveClipboardImage'),
    clipboardFilePaths: () => ipcRenderer.invoke('fs:clipboardFilePaths'),
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
    summarize: (changes: { type: string; name: string }[]) => ipcRenderer.invoke('settings:summarize', changes),
  },
  onMenuAction: (channel: string, callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  git: {
    isRepo: (cwd: string) => ipcRenderer.invoke('git:isRepo', cwd),
    status: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
    branch: (cwd: string) => ipcRenderer.invoke('git:branch', cwd),
    log: (cwd: string) => ipcRenderer.invoke('git:log', cwd),
    diffFile: (cwd: string, path: string) => ipcRenderer.invoke('git:diffFile', cwd, path),
    remoteInfo: (cwd: string) => ipcRenderer.invoke('git:remoteInfo', cwd),
    generateCommitMsg: (cwd: string) => ipcRenderer.invoke('git:generateCommitMsg', cwd),
  },
});
