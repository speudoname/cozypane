import Docker from 'dockerode';
import type { WebSocket } from '@fastify/websocket';
import type { FastifyBaseLogger } from 'fastify';
import { DOMAIN } from './serializers.js';

export const docker = new Docker({ socketPath: '/var/run/docker.sock' });

let log: FastifyBaseLogger = console as any;

export function setContainerLogger(logger: FastifyBaseLogger): void {
  log = logger;
}

const TIER_LIMITS: Record<string, { memory: number; nanoCpus: number }> = {
  small: { memory: 256 * 1024 * 1024, nanoCpus: 500_000_000 },       // 256MB, 0.5 CPU
  medium: { memory: 512 * 1024 * 1024, nanoCpus: 1_000_000_000 },    // 512MB, 1 CPU
  large: { memory: 1024 * 1024 * 1024, nanoCpus: 2_000_000_000 },    // 1GB, 2 CPU
};

export async function ensureNetwork(userId: number): Promise<string> {
  const networkName = `cp-user-${userId}`;

  // Check if user network already exists
  const networks = await docker.listNetworks({
    filters: { name: [networkName] },
  });

  if (networks.length === 0) {
    await docker.createNetwork({
      Name: networkName,
      Driver: 'bridge',
      Internal: false,
      Options: {
        'com.docker.network.bridge.enable_icc': 'true',
      },
    });
    log.info({ networkName }, 'Created user network');
  }

  // Connect Traefik to user network so it can route to containers on it.
  // This is best-effort — containers also get traefik-public as a fallback.
  try {
    const traefikContainers = await docker.listContainers({
      filters: { label: ['traefik.enable=true'], name: ['traefik'] },
    });
    if (traefikContainers.length > 0) {
      const net = docker.getNetwork(networkName);
      const netInfo = await net.inspect();
      const traefikId = traefikContainers[0].Id;
      const alreadyConnected = netInfo.Containers && netInfo.Containers[traefikId];
      if (!alreadyConnected) {
        await net.connect({ Container: traefikId });
        log.info({ networkName }, 'Connected Traefik to user network');
      }
    }
  } catch (err) {
    log.warn({ networkName, err }, 'Could not auto-connect Traefik to user network');
  }

  return networkName;
}

/**
 * Connect a container to a Docker network with verification.
 * Returns true if connected, false if failed.
 */
async function connectToNetwork(containerId: string, networkName: string): Promise<boolean> {
  try {
    const net = docker.getNetwork(networkName);
    await net.connect({ Container: containerId });

    // Verify the connection actually worked
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const connected = !!info.NetworkSettings?.Networks?.[networkName];
    if (!connected) {
      log.error({ containerId, networkName }, 'Container not on network after connect call');
    }
    return connected;
  } catch (err: any) {
    // Already connected is fine (HTTP 403 or "already exists")
    if (err.statusCode === 403 || err.message?.includes('already exists')) {
      return true;
    }
    log.error({ containerId, networkName, err: err.message }, 'Failed to connect container to network');
    return false;
  }
}

export async function runContainer(
  imageName: string,
  deployment: {
    id: number;
    appName: string;
    subdomain: string;
    port: number;
    tier: string;
    env?: Record<string, string>;
  },
  userId: number,
): Promise<string> {
  const containerName = `cp-${deployment.subdomain}`;
  const routerName = `cp-${deployment.subdomain}`;
  const domain = DOMAIN;
  const host = `${deployment.subdomain}.${domain}`;

  const userNetwork = await ensureNetwork(userId);
  const limits = TIER_LIMITS[deployment.tier] || TIER_LIMITS.small;

  // Build environment variables for the container
  const containerEnv = Object.entries(deployment.env || {}).map(
    ([k, v]) => `${k}=${v}`,
  );

  // Remove existing container with same name if it exists
  try {
    const existing = docker.getContainer(containerName);
    await existing.stop().catch(() => {});
    await existing.remove({ force: true });
  } catch {
    // Container doesn't exist, which is fine
  }

  const container = await docker.createContainer({
    Image: imageName,
    name: containerName,
    Env: containerEnv.length > 0 ? containerEnv : undefined,
    Labels: {
      'traefik.enable': 'true',
      [`traefik.http.routers.${routerName}.rule`]: `Host(\`${host}\`)`,
      [`traefik.http.routers.${routerName}.entrypoints`]: 'websecure',
      [`traefik.http.routers.${routerName}.tls`]: 'true',
      [`traefik.http.services.${routerName}.loadbalancer.server.port`]: String(deployment.port),
      'cozypane.user': String(userId),
      'cozypane.deployment': String(deployment.id),
      'cozypane.app': deployment.appName,
    },
    HostConfig: {
      Memory: limits.memory,
      NanoCpus: limits.nanoCpus,
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      NetworkMode: userNetwork,
      // Security hardening
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL'],
      CapAdd: ['NET_BIND_SERVICE'], // Allow binding to ports < 1024 if needed
      ReadonlyRootfs: false, // Many apps need writable fs; use tmpfs for /tmp instead
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
      PidsLimit: 256, // Prevent fork bombs
    },
  });

  await container.start();

  // Network connections after start:
  //
  // SECURITY (C2): Containers are NOT connected to traefik-public. That shared
  // network allowed cross-tenant reachability — any container could scan and
  // connect to any other container's internal port. Instead, Traefik discovers
  // containers via their per-user network (ensureNetwork connects Traefik to
  // cp-user-N above). This provides full tenant network isolation.
  //
  // internal is needed for DATABASE_URL with host=postgres.
  const INTERNAL_NETWORK = process.env.INTERNAL_NETWORK || 'cozypane-cloud_internal';
  const internalOk = await connectToNetwork(container.id, INTERNAL_NETWORK);
  if (!internalOk) {
    // Non-fatal for apps without databases, but log it
    log.warn({ containerName, network: INTERNAL_NETWORK }, 'Container not connected to internal network — database access may not work');
  }

  log.info({ containerName, networks: [userNetwork, INTERNAL_NETWORK] }, 'Started container');

  return container.id;
}

export async function stopContainer(containerId: string): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
    await container.stop({ t: 10 }).catch((err: any) => {
      // 304 = already stopped, 404 = already gone
      if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
    });
    await container.remove({ force: true }).catch((err: any) => {
      // 404 = already gone, 409 = removal already in progress
      if (err.statusCode !== 404 && err.statusCode !== 409) throw err;
    });
    log.info({ containerId }, 'Stopped and removed container');
  } catch (err: any) {
    if (err.statusCode !== 404) {
      throw err;
    }
    // Already gone
  }
}

/**
 * Restart an existing container in place. Consolidates the user `/redeploy`
 * and admin `/restart` paths that previously each instantiated their own
 * Docker client via dynamic import.
 */
export async function restartContainer(containerId: string, timeoutSec = 10): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.restart({ t: timeoutSec });
}

/**
 * Remove a Docker image by tag. Non-fatal — logs warnings.
 *
 * Audit L6: previously this only removed the exact `:latest` tag, so any
 * image that had been retagged or pushed under a different tag was
 * orphaned. Now also scans for any `cozypane/<userId>-<appName>:*`
 * variants and removes them too.
 */
export async function removeImage(imageTag: string): Promise<void> {
  try {
    const image = docker.getImage(imageTag);
    await image.remove({ force: true });
    log.info({ imageTag }, 'Removed image');
  } catch (err: any) {
    if (err.statusCode !== 404) {
      log.warn({ imageTag, err: err.message }, 'Failed to remove image');
    }
  }

  // Defensive cleanup: also drop any other tags under the same repository.
  // `cozypane/<userId>-<appName>` is the repo; `:latest` is the only tag we
  // write today, but builds from earlier app versions may still have stale
  // tags that would otherwise leak.
  const repo = imageTag.split(':')[0];
  if (!repo.startsWith('cozypane/')) return;
  try {
    const images = await docker.listImages({ filters: { reference: [repo] } });
    for (const img of images) {
      for (const tag of img.RepoTags || []) {
        if (tag === imageTag || tag === '<none>:<none>') continue;
        try {
          await docker.getImage(tag).remove({ force: true });
          log.info({ tag }, 'Removed orphaned image');
        } catch { /* non-fatal */ }
      }
    }
  } catch { /* non-fatal */ }
}

/**
 * Remove a user's Docker network if no containers are connected.
 */
export async function removeNetworkIfEmpty(userId: number): Promise<void> {
  const networkName = `cp-user-${userId}`;
  try {
    const networks = await docker.listNetworks({
      filters: { name: [networkName] },
    });
    if (networks.length === 0) return;

    const net = docker.getNetwork(networkName);
    const info = await net.inspect();
    const containers = info.Containers || {};
    const connectedContainers = Object.keys(containers);

    // Only Traefik or nothing — safe to remove
    const nonTraefik = connectedContainers.filter((id) => {
      const name = containers[id]?.Name || '';
      return !name.toLowerCase().includes('traefik');
    });

    if (nonTraefik.length === 0) {
      // Disconnect Traefik first if connected
      for (const id of connectedContainers) {
        await net.disconnect({ Container: id, Force: true }).catch(() => {});
      }
      await net.remove();
      log.info({ networkName }, 'Removed empty network');
    }
  } catch (err: any) {
    if (err.statusCode !== 404) {
      log.warn({ networkName, err: err.message }, 'Failed to remove network');
    }
  }
}

export async function getContainerLogs(
  containerId: string,
  tail: number = 200,
): Promise<string> {
  const container = docker.getContainer(containerId);
  const logs = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });

  // Docker multiplexed stream: strip 8-byte header from each frame
  return redactInternals(demuxLogs(logs as unknown as Buffer));
}

export function streamLogs(containerId: string, ws: WebSocket): void {
  const container = docker.getContainer(containerId);

  container
    .logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail: 50,
      timestamps: true,
    })
    .then((stream) => {
      stream.on('data', (chunk: Buffer) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(redactInternals(demuxLogs(chunk)));
        }
      });

      stream.on('end', () => {
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, 'Container logs ended');
        }
      });

      stream.on('error', (err) => {
        if (ws.readyState === ws.OPEN) {
          ws.close(1011, 'Log stream error');
        }
      });

      ws.on('close', () => {
        (stream as any).destroy?.();
      });
    })
    .catch((err) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ error: err.message }));
        ws.close(1011, 'Log stream error');
      }
    });
}

export function execInContainer(containerId: string, ws: WebSocket): void {
  const container = docker.getContainer(containerId);

  container
    .exec({
      Cmd: ['/bin/sh'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    })
    .then(async (exec) => {
      const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
      return { exec, stream };
    })
    .then(({ exec, stream }) => {
      // Container -> WebSocket
      stream.on('data', (chunk: Buffer) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(chunk.toString('utf-8'));
        }
      });

      stream.on('end', () => {
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, 'Exec session ended');
        }
      });

      stream.on('error', () => {
        if (ws.readyState === ws.OPEN) {
          ws.close(1011, 'Exec stream error');
        }
      });

      // WebSocket -> Container
      ws.on('message', (data: Buffer | string) => {
        stream.write(typeof data === 'string' ? data : data.toString('utf-8'));
      });

      // On client disconnect, previously the code only called `stream.end()`
      // which gracefully closes stdin but leaves the docker exec process
      // running server-side. Over time this leaked zombie shells inside
      // tenant containers. Now we also try to SIGKILL any remaining child
      // via `kill -9 $PPID` (the exec shell) and destroy the hijacked
      // stream so the socket to dockerd is fully torn down.
      ws.on('close', () => {
        try {
          // Best-effort kill: write a shell command that hard-kills the
          // exec session. If stream is already closed this throws; we
          // swallow because the cleanup is best-effort.
          stream.write('\x03\nkill -9 $$\n');
        } catch { /* ignore */ }
        try { stream.end(); } catch { /* ignore */ }
        try { (stream as any).destroy?.(); } catch { /* ignore */ }
        // Also query the exec state and resize=0 so dockerd releases it.
        exec.inspect().catch(() => {});
      });
    })
    .catch((err) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ error: err.message }));
        ws.close(1011, 'Exec error');
      }
    });
}

/**
 * Wait for a container to become healthy (responding to HTTP requests).
 */
export async function waitForHealthy(
  containerId: string,
  port: number,
  maxWaitMs: number = 60000,
): Promise<{ healthy: boolean; error?: string; logs?: string }> {
  const container = docker.getContainer(containerId);

  // Wait 2s for initial boot
  await new Promise(r => setTimeout(r, 2000));

  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const info = await container.inspect();

      // Check if container crashed
      if (!info.State.Running) {
        const logs = await getContainerLogs(containerId, 30).catch(() => 'Could not retrieve logs');
        return {
          healthy: false,
          error: `Container exited with code ${info.State.ExitCode}`,
          logs,
        };
      }

      // Find a reachable IP — use any available network IP (containers are
      // on per-user networks, not traefik-public, since the C2 isolation fix)
      const networks = info.NetworkSettings?.Networks || {};
      let ip: string | undefined;
      for (const net of Object.values(networks) as any[]) {
        if (net?.IPAddress) { ip = net.IPAddress; break; }
      }

      if (!ip) {
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      // Try HTTP request on the container's IP
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`http://${ip}:${port}/`, { signal: controller.signal });
        clearTimeout(timeout);
        // Any HTTP response (even 404/500) = healthy
        return { healthy: true };
      } catch {
        clearTimeout(timeout);
      }
    } catch (err: any) {
      return {
        healthy: false,
        error: `Container inspection failed: ${err.message}`,
      };
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  const logs = await getContainerLogs(containerId, 30).catch(() => 'Could not retrieve logs');
  return {
    healthy: false,
    error: `Health check timed out after ${maxWaitMs / 1000}s — server not responding on port ${port}`,
    logs,
  };
}

/**
 * Redact internal infrastructure details from log output.
 * Strips container IDs and internal Docker network IPs.
 */
function redactInternals(text: string): string {
  // Redact full container IDs (64-char hex)
  text = text.replace(/\b[0-9a-f]{64}\b/g, '[container]');
  // Redact short container IDs (12-char hex). Only match standalone 12-char
  // hex strings that don't appear inside longer hex sequences (timestamps,
  // UUIDs, etc.) — require whitespace or line boundary on both sides.
  text = text.replace(/(?<=^|[\s:])([0-9a-f]{12})(?=$|[\s,.])/gm, '[container]');
  // Redact internal Docker bridge IPs (172.x.x.x)
  text = text.replace(/\b172\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[internal-ip]');
  return text;
}

/**
 * Demultiplex Docker log stream.
 * Each frame has an 8-byte header: [type(1), 0, 0, 0, size(4 big-endian)]
 */
export async function getDockerHealth() {
  try {
    const containers = await docker.listContainers({ all: true });
    const running = containers.filter(c => c.State === 'running').length;
    const images = await docker.listImages();
    return {
      status: 'running' as const,
      containers: { total: containers.length, running, stopped: containers.length - running },
      images: images.length,
    };
  } catch {
    return { status: 'unreachable' as const, containers: { total: 0, running: 0, stopped: 0 }, images: 0 };
  }
}

function demuxLogs(buffer: Buffer): string {
  if (!Buffer.isBuffer(buffer)) {
    return String(buffer);
  }

  const lines: string[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      // Incomplete header, just grab the rest
      lines.push(buffer.subarray(offset).toString('utf-8'));
      break;
    }

    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + size > buffer.length) {
      lines.push(buffer.subarray(offset).toString('utf-8'));
      break;
    }

    lines.push(buffer.subarray(offset, offset + size).toString('utf-8'));
    offset += size;
  }

  return lines.join('');
}
