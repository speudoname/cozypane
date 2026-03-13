import { ipcMain } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';

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
    const commands = new Map<string, { cmd: string; desc: string; source: string }>();

    // 1. Built-in commands
    const builtins = [
      { cmd: '/help', desc: 'Show help and available commands' },
      { cmd: '/clear', desc: 'Clear conversation history' },
      { cmd: '/compact', desc: 'Compact conversation to save context' },
      { cmd: '/config', desc: 'View or modify configuration' },
      { cmd: '/cost', desc: 'Show token usage and cost' },
      { cmd: '/doctor', desc: 'Check Claude Code health' },
      { cmd: '/init', desc: 'Initialize project with CLAUDE.md' },
      { cmd: '/login', desc: 'Switch accounts or login' },
      { cmd: '/logout', desc: 'Sign out of current session' },
      { cmd: '/memory', desc: 'Edit CLAUDE.md memory file' },
      { cmd: '/model', desc: 'Switch AI model' },
      { cmd: '/permissions', desc: 'View or modify permissions' },
      { cmd: '/review', desc: 'Review a pull request' },
      { cmd: '/status', desc: 'Show current status' },
      { cmd: '/terminal-setup', desc: 'Install shell integration' },
      { cmd: '/vim', desc: 'Enter vim mode for editing' },
    ];
    for (const b of builtins) {
      commands.set(b.cmd, { ...b, source: 'built-in' });
    }

    // Helper: scan a commands directory for .md files
    async function scanCommandsDir(dir: string, source: string) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const cmdName = '/' + entry.name.replace(/\.md$/, '');
          let desc = 'Custom command';
          try {
            const content = await fs.promises.readFile(path.join(dir, entry.name), 'utf-8');
            // Try YAML frontmatter first
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const descMatch = fmMatch[1].match(/^description:\s*(.+)/m);
              if (descMatch) desc = descMatch[1].trim().replace(/^["']|["']$/g, '').slice(0, 80);
            } else {
              const firstLine = content.split('\n').find(l => l.trim().length > 0);
              if (firstLine) desc = firstLine.trim().replace(/^#+\s*/, '').slice(0, 80);
            }
          } catch {}
          commands.set(cmdName, { cmd: cmdName, desc, source });
        }
      } catch {}
    }

    // 2. Global custom commands
    const home = os.homedir();
    await scanCommandsDir(path.join(home, '.claude', 'commands'), 'global');

    // 3. Project custom commands
    if (cwd) {
      await scanCommandsDir(path.join(cwd, '.claude', 'commands'), 'project');
    }

    // 4. Installed skills
    try {
      const skillsDir = path.join(home, '.claude', 'skills');
      const skillEntries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
      for (const entry of skillEntries) {
        if (!entry.isDirectory()) continue;
        try {
          const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
          const content = await fs.promises.readFile(skillFile, 'utf-8');
          // Parse YAML frontmatter
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const fm = fmMatch[1];
            const nameMatch = fm.match(/^name:\s*(.+)/m);
            const descMatch = fm.match(/^description:\s*(.+)/m);
            const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : entry.name;
            const desc = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : 'Installed skill';
            const cmd = '/' + name.toLowerCase().replace(/\s+/g, '-');
            commands.set(cmd, { cmd, desc, source: 'skill' });
          }
        } catch {}
      }
    } catch {}

    // 5. Plugin commands (marketplace plugins)
    const marketplacesDir = path.join(home, '.claude', 'plugins', 'marketplaces');
    try {
      const marketplaces = await fs.promises.readdir(marketplacesDir, { withFileTypes: true });
      for (const mp of marketplaces) {
        if (!mp.isDirectory()) continue;
        for (const sub of ['plugins', 'external_plugins']) {
          const pluginsDir = path.join(marketplacesDir, mp.name, sub);
          try {
            const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
            for (const plugin of plugins) {
              if (!plugin.isDirectory()) continue;
              await scanCommandsDir(
                path.join(pluginsDir, plugin.name, 'commands'),
                'plugin'
              );
            }
          } catch {}
        }
      }
    } catch {}

    // 6. Installed plugin cache commands
    try {
      const installedPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
      const installedRaw = await fs.promises.readFile(installedPath, 'utf-8');
      const installed = JSON.parse(installedRaw);
      if (installed.plugins) {
        for (const entries of Object.values(installed.plugins) as any[]) {
          for (const entry of entries) {
            if (entry.installPath) {
              await scanCommandsDir(path.join(entry.installPath, 'commands'), 'plugin');
            }
          }
        }
      }
    } catch {}

    return Array.from(commands.values());
  });
}
