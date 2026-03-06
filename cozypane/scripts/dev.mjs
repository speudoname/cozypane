import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Start Vite dev server
const vite = spawn('npx', ['vite', '--host'], {
  cwd: root,
  stdio: 'pipe',
  shell: true,
});

let electronStarted = false;

vite.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(`[vite] ${output}`);

  // Wait for Vite to be ready before starting Electron
  if (!electronStarted && output.includes('Local:')) {
    electronStarted = true;

    // Parse the actual port Vite is using
    const portMatch = output.match(/localhost:(\d+)/);
    const port = portMatch ? portMatch[1] : '5173';
    console.log(`\n[dev] Vite ready on port ${port}, building & starting Electron...\n`);

    // Build main process TypeScript
    const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.main.json'], {
      cwd: root,
      stdio: 'inherit',
      shell: true,
    });

    tsc.on('close', (code) => {
      if (code !== 0) {
        console.error('[dev] TypeScript compilation failed');
        process.exit(1);
      }

      // Start Electron with the correct Vite port
      const electron = spawn('npx', ['electron', '.'], {
        cwd: root,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, NODE_ENV: 'development', VITE_DEV_PORT: port },
      });

      electron.on('close', () => {
        vite.kill();
        process.exit(0);
      });
    });
  }
});

vite.stderr.on('data', (data) => {
  process.stderr.write(`[vite] ${data}`);
});

process.on('SIGINT', () => {
  vite.kill();
  process.exit(0);
});
