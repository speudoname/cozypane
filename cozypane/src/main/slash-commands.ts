import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';

interface SlashCommand {
  cmd: string;
  desc: string;
  source: string;
}

// Cache for binary extraction (keyed by mtime)
let binaryCache: { mtime: number; commands: SlashCommand[] } | null = null;

// Internal commands and non-slash-command names to filter out.
// Note: names containing underscores are also filtered (MCP tools use underscores,
// real slash commands use hyphens or plain words — zero overlap).
const FILTERED_NAMES = new Set([
  'bridge-kick', 'heapdump', 'thinkback-play',
  'command', 'count', 'definition', 'duration', 'files',
  'sleep', 'srun', 'nohup', 'time', 'timeout', 'install',
  'scroll', 'type', 'wait', 'zoom', 'navigate', 'batch',
  'debug', 'alias',
]);

/**
 * Resolve the Claude Code binary path by checking PATH and resolving symlinks.
 */
async function findClaudeBinary(): Promise<string | null> {
  const home = os.homedir();

  // 1. Check common symlink locations
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
  ];

  for (const candidate of candidates) {
    try {
      const resolved = await fs.promises.realpath(candidate);
      const stat = await fs.promises.stat(resolved);
      if (stat.isFile()) return resolved;
    } catch {}
  }

  // 2. Search PATH for 'claude' binary
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'claude');
    try {
      const resolved = await fs.promises.realpath(candidate);
      const stat = await fs.promises.stat(resolved);
      if (stat.isFile()) return resolved;
    } catch {}
  }

  // 3. Fallback: check versioned installation directory (pick latest)
  const versionsDir = path.join(home, '.local', 'share', 'claude', 'versions');
  try {
    const entries = await fs.promises.readdir(versionsDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
    for (const ver of dirs) {
      const candidate = path.join(versionsDir, ver, 'claude');
      try {
        const stat = await fs.promises.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {}
    }
  } catch {}

  return null;
}

/**
 * Extract slash commands from the Claude Code binary using `strings`.
 */
async function extractFromBinary(): Promise<SlashCommand[]> {
  const binaryPath = await findClaudeBinary();
  if (!binaryPath) return [];

  try {
    const stat = await fs.promises.stat(binaryPath);
    const mtime = stat.mtimeMs;

    // Return cached result if binary hasn't changed
    if (binaryCache && binaryCache.mtime === mtime) {
      return binaryCache.commands;
    }

    const commands = await new Promise<SlashCommand[]>((resolve) => {
      execFile('/usr/bin/strings', [binaryPath], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
        if (err) { resolve([]); return; }

        const results: SlashCommand[] = [];
        // Match patterns like: name:"help",description:"Show help and available commands"
        const regex = /name:"([a-z][\w-]*)",description:"([^"]+)"/g;
        let match;
        while ((match = regex.exec(stdout)) !== null) {
          const name = match[1];
          const desc = match[2];
          if (FILTERED_NAMES.has(name)) continue;
          // MCP tools use underscores, slash commands use hyphens/plain words
          if (name.includes('_')) continue;
          // Skip single-character names and very short generic names
          if (name.length <= 2) continue;
          results.push({ cmd: '/' + name, desc, source: 'built-in' });
        }
        resolve(results);
      });
    });

    binaryCache = { mtime, commands };
    return commands;
  } catch {
    return [];
  }
}

/**
 * Scan a directory of .md files for custom commands.
 */
async function scanCommandsDir(dir: string, source: string): Promise<SlashCommand[]> {
  const commands: SlashCommand[] = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const cmdName = '/' + entry.name.replace(/\.md$/, '');
      let desc = 'Custom command';
      try {
        const content = await fs.promises.readFile(path.join(dir, entry.name), 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const descMatch = fmMatch[1].match(/^description:\s*(.+)/m);
          if (descMatch) desc = descMatch[1].trim().replace(/^["']|["']$/g, '').slice(0, 80);
        } else {
          const firstLine = content.split('\n').find(l => l.trim().length > 0);
          if (firstLine) desc = firstLine.trim().replace(/^#+\s*/, '').slice(0, 80);
        }
      } catch {}
      commands.push({ cmd: cmdName, desc, source });
    }
  } catch {}
  return commands;
}

/**
 * Parse a SKILL.md file and return the slash command if user-invocable.
 */
async function parseSkillFile(skillFile: string, source: string): Promise<SlashCommand | null> {
  try {
    const content = await fs.promises.readFile(skillFile, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];

    // Respect user_invocable field — skip if explicitly false
    const invocableMatch = fm.match(/^user_invocable:\s*(.+)/m);
    if (invocableMatch && invocableMatch[1].trim().toLowerCase() === 'false') return null;

    const nameMatch = fm.match(/^name:\s*(.+)/m);
    const descMatch = fm.match(/^description:\s*(.+)/m);
    const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : path.basename(path.dirname(skillFile));
    const desc = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : 'Installed skill';
    const cmd = '/' + name.toLowerCase().replace(/\s+/g, '-');
    return { cmd, desc, source };
  } catch {
    return null;
  }
}

/**
 * Scan installed skills from ~/.claude/skills/
 */
async function scanInstalledSkills(): Promise<SlashCommand[]> {
  const commands: SlashCommand[] = [];
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  try {
    const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cmd = await parseSkillFile(path.join(skillsDir, entry.name, 'SKILL.md'), 'skill');
      if (cmd) commands.push(cmd);
    }
  } catch {}
  return commands;
}

/**
 * Scan marketplace skills from ~/.claude/plugins/marketplaces/
 */
async function scanMarketplaceSkills(): Promise<SlashCommand[]> {
  const commands: SlashCommand[] = [];
  const home = os.homedir();
  const marketplacesDir = path.join(home, '.claude', 'plugins', 'marketplaces');

  try {
    const marketplaces = await fs.promises.readdir(marketplacesDir, { withFileTypes: true });
    for (const mp of marketplaces) {
      if (!mp.isDirectory()) continue;

      // Scan skills/ directory (the bug fix — previously only commands/ was scanned)
      const skillsDir = path.join(marketplacesDir, mp.name, 'skills');
      try {
        const skills = await fs.promises.readdir(skillsDir, { withFileTypes: true });
        for (const skill of skills) {
          if (!skill.isDirectory()) continue;
          const cmd = await parseSkillFile(path.join(skillsDir, skill.name, 'SKILL.md'), 'marketplace');
          if (cmd) commands.push(cmd);
        }
      } catch {}

      // Also scan plugin commands (existing behavior)
      for (const sub of ['plugins', 'external_plugins']) {
        const pluginsDir = path.join(marketplacesDir, mp.name, sub);
        try {
          const plugins = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
          for (const plugin of plugins) {
            if (!plugin.isDirectory()) continue;
            const pluginCommands = await scanCommandsDir(
              path.join(pluginsDir, plugin.name, 'commands'),
              'plugin'
            );
            commands.push(...pluginCommands);
          }
        } catch {}
      }
    }
  } catch {}

  // Also check installed_plugins.json cache
  try {
    const installedPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    const installedRaw = await fs.promises.readFile(installedPath, 'utf-8');
    const installed = JSON.parse(installedRaw);
    if (installed.plugins) {
      for (const entries of Object.values(installed.plugins) as any[]) {
        for (const entry of entries) {
          if (entry.installPath) {
            const pluginCommands = await scanCommandsDir(
              path.join(entry.installPath, 'commands'),
              'plugin'
            );
            commands.push(...pluginCommands);
          }
        }
      }
    }
  } catch {}

  return commands;
}

/**
 * Get all available slash commands from all sources.
 * Later sources override earlier ones (deduplication by command name).
 */
export async function getSlashCommands(cwd?: string): Promise<SlashCommand[]> {
  const commands = new Map<string, SlashCommand>();

  // Source 1: Binary extraction (built-in commands)
  const builtinCommands = await extractFromBinary();
  for (const cmd of builtinCommands) {
    commands.set(cmd.cmd, cmd);
  }

  // Source 2: Global custom commands
  const home = os.homedir();
  const globalCommands = await scanCommandsDir(path.join(home, '.claude', 'commands'), 'global');
  for (const cmd of globalCommands) {
    commands.set(cmd.cmd, cmd);
  }

  // Source 3: Project custom commands
  if (cwd) {
    const projectCommands = await scanCommandsDir(path.join(cwd, '.claude', 'commands'), 'project');
    for (const cmd of projectCommands) {
      commands.set(cmd.cmd, cmd);
    }
  }

  // Source 4: Installed skills
  const skills = await scanInstalledSkills();
  for (const cmd of skills) {
    commands.set(cmd.cmd, cmd);
  }

  // Source 5: Marketplace skills and plugin commands
  const marketplace = await scanMarketplaceSkills();
  for (const cmd of marketplace) {
    commands.set(cmd.cmd, cmd);
  }

  return Array.from(commands.values());
}
