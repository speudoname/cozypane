import Docker from 'dockerode';
import type { WebSocket } from '@fastify/websocket';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

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
      Internal: false, // Needs outbound for package installs etc.
      Options: {
        'com.docker.network.bridge.enable_icc': 'true', // Allow same-user containers to talk
      },
    });
    console.log(`Created network: ${networkName}`);
  }

  // Ensure Traefik is connected to this user network so it can route traffic
  // without needing to put tenant containers on the shared traefik-public network
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
        console.log(`Connected Traefik to network: ${networkName}`);
      }
    }
  } catch (err) {
    // Non-fatal — traefik may connect on its own or be manually connected
    console.warn(`Could not auto-connect Traefik to ${networkName}:`, err);
  }

  return networkName;
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
  const domain = process.env.DOMAIN || 'cozypane.com';
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

  // Traefik discovers this container via its user network (ensureNetwork connects
  // Traefik to each user network). We do NOT connect to traefik-public, which would
  // let tenant containers reach each other through the shared network.

  await container.start();
  console.log(`Started container: ${containerName} (${container.id})`);

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
    console.log(`Stopped and removed container: ${containerId}`);
  } catch (err: any) {
    if (err.statusCode !== 404) {
      throw err;
    }
    // Already gone
  }
}

/**
 * Remove a Docker image by tag. Non-fatal — logs warnings.
 */
export async function removeImage(imageTag: string): Promise<void> {
  try {
    const image = docker.getImage(imageTag);
    await image.remove({ force: true });
    console.log(`Removed image: ${imageTag}`);
  } catch (err: any) {
    if (err.statusCode !== 404) {
      console.warn(`Failed to remove image ${imageTag}:`, err.message);
    }
  }
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
      console.log(`Removed empty network: ${networkName}`);
    }
  } catch (err: any) {
    if (err.statusCode !== 404) {
      console.warn(`Failed to remove network ${networkName}:`, err.message);
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
    .then((exec) => {
      return exec.start({ hijack: true, stdin: true, Tty: true });
    })
    .then((stream) => {
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

      stream.on('error', (err) => {
        if (ws.readyState === ws.OPEN) {
          ws.close(1011, 'Exec stream error');
        }
      });

      // WebSocket -> Container
      ws.on('message', (data: Buffer | string) => {
        stream.write(typeof data === 'string' ? data : data.toString('utf-8'));
      });

      ws.on('close', () => {
        stream.end();
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
 * Redact internal infrastructure details from log output.
 * Strips container IDs and internal Docker network IPs.
 */
function redactInternals(text: string): string {
  // Redact full container IDs (64-char hex)
  text = text.replace(/\b[0-9a-f]{64}\b/g, '[container]');
  // Redact short container IDs (12-char hex, only when they look like Docker IDs)
  text = text.replace(/\b[0-9a-f]{12}\b/g, '[container]');
  // Redact internal Docker bridge IPs (172.x.x.x)
  text = text.replace(/\b172\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[internal-ip]');
  return text;
}

/**
 * Demultiplex Docker log stream.
 * Each frame has an 8-byte header: [type(1), 0, 0, 0, size(4 big-endian)]
 */
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
