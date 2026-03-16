import { ipcMain } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getSlashCommands } from './slash-commands';

export function registerFsHandlers() {
  ipcMain.handle('fs:readdir', async (_event, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter(entry => entry.name !== '.git')
        .map(entry => ({
          name: entry.name,
          path: path.join(dirPath, entry.name),
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        }))
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return [];
    }
  });

  ipcMain.handle('fs:readfile', async (_event, filePath: string) => {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 1024 * 1024) {
        return { error: 'File too large to preview (>1MB)' };
      }
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { content, size: stat.size };
    } catch {
      return { error: 'Could not read file' };
    }
  });

  // Read binary file as base64 (for images, etc.)
  ipcMain.handle('fs:readBinary', async (_event, filePath: string) => {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 20 * 1024 * 1024) {
        return { error: 'File too large to preview (>20MB)' };
      }
      const buffer = await fs.promises.readFile(filePath);
      const base64 = buffer.toString('base64');
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        ico: 'image/x-icon', bmp: 'image/bmp',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
        pdf: 'application/pdf',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      return { base64, mime, size: stat.size };
    } catch {
      return { error: 'Could not read file' };
    }
  });

  ipcMain.handle('fs:writefile', async (_event, filePath: string, content: string) => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (err: any) {
      return { error: err.message || 'Could not write file' };
    }
  });

  ipcMain.handle('fs:homedir', () => {
    return os.homedir();
  });

  ipcMain.handle('fs:getSlashCommands', async (_event, cwd?: string) => {
    return getSlashCommands(cwd);
  });
}
