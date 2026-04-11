import { ipcMain, BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// L30: `UpdateInfo` was previously exported but nothing imported it — the
// renderer uses the global ambient type in `renderer/types.d.ts`. Dropping
// the `export` so the type stays module-local as an internal return type.
interface UpdateInfo {
  brewOutdated: { name: string; current: string; latest: string }[];
  claudeUpdate: { current: string; latest: string } | null;
  checkedAt: number;
}

let lastCheck: UpdateInfo | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;

async function getBrewOutdated(): Promise<{ name: string; current: string; latest: string }[]> {
  try {
    const { stdout } = await execFileAsync('/opt/homebrew/bin/brew', ['outdated', '--json=v2'], { timeout: 30000 });
    const data = JSON.parse(stdout);
    const formulae = (data.formulae || []).map((f: any) => ({
      name: f.name,
      current: f.installed_versions?.[0] || 'unknown',
      latest: f.current_version || 'unknown',
    }));
    const casks = (data.casks || []).map((c: any) => ({
      name: c.name,
      current: c.installed_versions || 'unknown',
      latest: c.current_version || 'unknown',
    }));
    return [...formulae, ...casks];
  } catch (err: any) {
    // brew not installed or failed
    console.log('[CozyPane] brew outdated check failed:', err.message);
    return [];
  }
}

async function getClaudeVersions(): Promise<{ current: string; latest: string } | null> {
  try {
    // Get current installed version
    const { stdout: currentRaw } = await execFileAsync('/usr/bin/env', ['claude', '--version'], {
      timeout: 10000,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    });
    const current = currentRaw.trim().split('\n')[0].replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1');

    // Get latest version from npm registry
    const { stdout: latestRaw } = await execFileAsync('/usr/bin/env', ['npm', 'view', '@anthropic-ai/claude-code', 'version'], {
      timeout: 10000,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    });
    const latest = latestRaw.trim();

    if (current && latest && current !== latest) {
      return { current, latest };
    }
    return null;
  } catch (err: any) {
    console.log('[CozyPane] claude version check failed:', err.message);
    return null;
  }
}

async function runCheck(getWindow: () => BrowserWindow | null): Promise<UpdateInfo> {
  const [brewOutdated, claudeUpdate] = await Promise.all([
    getBrewOutdated(),
    getClaudeVersions(),
  ]);

  lastCheck = { brewOutdated, claudeUpdate, checkedAt: Date.now() };

  // Notify renderer if there are updates
  const win = getWindow();
  if (win && !win.isDestroyed() && (brewOutdated.length > 0 || claudeUpdate)) {
    win.webContents.send('updates:available', lastCheck);
  }

  return lastCheck;
}

export function registerUpdateCheckerHandlers(getWindow: () => BrowserWindow | null) {
  // Manual check from renderer
  ipcMain.handle('updates:check', async () => {
    return runCheck(getWindow);
  });

  // Get last check result
  ipcMain.handle('updates:getLast', () => {
    return lastCheck;
  });

  // Build the update command string
  ipcMain.handle('updates:getCommand', (_event, opts: { brew: boolean; claude: boolean }) => {
    const commands: string[] = [];
    if (opts.brew && lastCheck?.brewOutdated.length) {
      commands.push('brew upgrade');
    }
    if (opts.claude && lastCheck?.claudeUpdate) {
      commands.push('claude update');
    }
    return commands.join(' && ');
  });
}

export function startPeriodicCheck(getWindow: () => BrowserWindow | null) {
  // Initial check after 5 seconds (let the app settle)
  setTimeout(() => runCheck(getWindow), 5000);

  // Re-check every 4 hours
  checkInterval = setInterval(() => runCheck(getWindow), 4 * 60 * 60 * 1000);
}

export function stopPeriodicCheck() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
