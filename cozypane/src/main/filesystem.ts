import { ipcMain } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';

export function registerFsHandlers() {
  ipcMain.handle('fs:readdir', async (_event, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter(entry => !entry.name.startsWith('.') || entry.name === '.env')
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
}
