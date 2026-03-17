import Docker from 'dockerode';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectInfo } from './detector.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const DOCKERFILES: Record<string, string> = {
  node: `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
`,

  python: `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* pyproject.toml* ./
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || pip install --no-cache-dir . 2>/dev/null || true
COPY . .
EXPOSE 8000
CMD ["python", "-m", "gunicorn", "--bind", "0.0.0.0:8000", "app:app"]
`,

  go: `FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /server .

FROM scratch
COPY --from=builder /server /server
EXPOSE 8080
CMD ["/server"]
`,

  static: `FROM nginx:alpine
COPY . /usr/share/nginx/html
RUN sed -i 's/listen       80;/listen       8080;/g' /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
`,
};

export interface BuildResult {
  tag: string;
  buildLog: string;
}

export async function buildImage(
  projectDir: string,
  projectInfo: ProjectInfo,
  appName: string,
  userId: number,
): Promise<BuildResult> {
  const tag = `cozypane/${userId}-${appName}:latest`;

  // Generate Dockerfile if none exists and type is not 'docker'
  if (projectInfo.type !== 'docker' && !existsSync(join(projectDir, 'Dockerfile'))) {
    const template = DOCKERFILES[projectInfo.type];
    if (template) {
      writeFileSync(join(projectDir, 'Dockerfile'), template);
    }
  }

  // Build image using Docker API
  const BUILD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  const stream = await docker.buildImage(
    {
      context: projectDir,
      src: ['.'],
    } as any,
    {
      t: tag,
      rm: true,
      forcerm: true,
      memory: 512 * 1024 * 1024,    // 512MB build memory limit
      cpuquota: 100000,              // 1 CPU worth of quota
    },
  );

  // Wait for build to complete with timeout, capturing output
  const buildLines: string[] = [];
  const buildPromise = new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
      (event: { stream?: string; error?: string }) => {
        if (event.stream) {
          buildLines.push(event.stream);
          process.stdout.write(event.stream);
        }
        if (event.error) {
          buildLines.push(`ERROR: ${event.error}`);
          reject(new Error(event.error));
        }
      },
    );
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Build timed out after 10 minutes')), BUILD_TIMEOUT_MS);
  });

  await Promise.race([buildPromise, timeoutPromise]);

  return { tag, buildLog: buildLines.join('') };
}
