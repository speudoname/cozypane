import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cozyPane', {
  terminal: {
    write: (data: string) => ipcRenderer.send('terminal:write', data),
    resize: (cols: number, rows: number) => ipcRenderer.send('terminal:resize', cols, rows),
    onData: (callback: (data: string) => void) => {
      const listener = (_event: any, data: string) => callback(data);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    onExit: (callback: (code: number) => void) => {
      const listener = (_event: any, code: number) => callback(code);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    },
    create: (cwd?: string) => ipcRenderer.invoke('terminal:create', cwd),
    getCwd: () => ipcRenderer.invoke('terminal:getCwd'),
  },
  fs: {
    readdir: (dirPath: string) => ipcRenderer.invoke('fs:readdir', dirPath),
    readfile: (filePath: string) => ipcRenderer.invoke('fs:readfile', filePath),
    writefile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writefile', filePath, content),
    homedir: () => ipcRenderer.invoke('fs:homedir'),
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
  git: {
    isRepo: (cwd: string) => ipcRenderer.invoke('git:isRepo', cwd),
    status: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
    branch: (cwd: string) => ipcRenderer.invoke('git:branch', cwd),
    log: (cwd: string) => ipcRenderer.invoke('git:log', cwd),
    stage: (cwd: string, path: string) => ipcRenderer.invoke('git:stage', cwd, path),
    unstage: (cwd: string, path: string) => ipcRenderer.invoke('git:unstage', cwd, path),
    stageAll: (cwd: string) => ipcRenderer.invoke('git:stageAll', cwd),
    unstageAll: (cwd: string) => ipcRenderer.invoke('git:unstageAll', cwd),
    commit: (cwd: string, message: string) => ipcRenderer.invoke('git:commit', cwd, message),
    diffFile: (cwd: string, path: string) => ipcRenderer.invoke('git:diffFile', cwd, path),
    revertFile: (cwd: string, path: string) => ipcRenderer.invoke('git:revertFile', cwd, path),
    revertFiles: (cwd: string, paths: string[]) => ipcRenderer.invoke('git:revertFiles', cwd, paths),
  },
});
