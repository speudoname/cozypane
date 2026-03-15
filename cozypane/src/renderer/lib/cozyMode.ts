const COZY_MODE_MARKER = '<!-- COZY_MODE: managed by CozyPane -->';

const COZY_MODE_CONTENT = `${COZY_MODE_MARKER}
# CozyPane Deployment Guide

This project is managed by CozyPane. When building, follow these conventions so deployment works seamlessly.

## Deployment Architecture
- Each service deploys as a separate container with its own subdomain: \`<appName>-<username>.cozypane.com\`
- Multi-service apps (frontend + backend) are deployed as separate services linked by a "group"
- HTTPS is automatic via wildcard cert — no SSL config needed

## How to Structure the Project

### Single-service app (API, web app, static site)
- Put a \`Dockerfile\` in the project root
- Expose ONE HTTP port (default: 3000, NOT port 80)
- Include a production start command (e.g. \`"start": "node server.js"\` in package.json)

### Multi-service app (frontend + backend)
- Keep services in separate directories (e.g. \`frontend/\`, \`backend/\`, \`api/\`)
- Each service gets its own \`Dockerfile\`
- Deploy backend FIRST, then pass its URL to the frontend via env vars
- Use env vars for inter-service URLs (e.g. \`VITE_API_URL\`, \`NEXT_PUBLIC_API_URL\`), never hardcode localhost

## Database
- If the app needs a database, CozyPane provisions a managed PostgreSQL automatically
- Do NOT bundle PostgreSQL in the Dockerfile (no \`apt install postgresql\`, no embedded DB)
- The platform injects \`DATABASE_URL\` as an environment variable into the container
- Run database migrations at container startup:
  - Prisma: \`npx prisma migrate deploy && node server.js\`
  - Drizzle: \`npx drizzle-kit migrate && node server.js\`
  - Django: \`python manage.py migrate && gunicorn ...\`
  - Knex/Sequelize: run migrations in your start script before the server starts
- When you detect database dependencies (prisma, knex, sequelize, typeorm, drizzle, pg, psycopg2, sqlalchemy, django), set \`needsDatabase: "postgres"\` when deploying

## Code Conventions for Production
- Use relative API paths (e.g. \`/api/users\`) or env-var-based URLs, never \`http://localhost:...\`
- CORS: allow the production origin (\`https://<app>-<user>.cozypane.com\`) or use relative paths so CORS isn't needed
- Environment-specific config should use env vars, not hardcoded values
- Include a \`.dockerignore\` with \`node_modules\`, \`.git\`, \`.env\`
- Do NOT use port 80 in the container — it conflicts with the platform's reverse proxy

## Deploying
When the user says "cozydeploy" or asks to deploy, use the \`cozypane_deploy\` MCP tool:
- For multi-service: deploy each service separately with a shared \`group\` name
- Deploy order: databases/backends first, then frontends (so you have the URL to pass)
- Pass env vars like \`API_URL\` to frontends via the \`env\` parameter
`;

export async function isCozyModeEnabled(cwd: string): Promise<boolean> {
  try {
    const claudeMdPath = cwd + '/CLAUDE.md';
    const result = await window.cozyPane.fs.readfile(claudeMdPath);
    if (result.content && result.content.includes(COZY_MODE_MARKER)) {
      return true;
    }
  } catch {}
  return false;
}

export async function enableCozyMode(cwd: string): Promise<void> {
  const claudeMdPath = cwd + '/CLAUDE.md';
  let existingContent = '';
  try {
    const result = await window.cozyPane.fs.readfile(claudeMdPath);
    if (result.content) {
      if (result.content.includes(COZY_MODE_MARKER)) return;
      existingContent = result.content;
    }
  } catch {}

  const newContent = existingContent
    ? existingContent.trimEnd() + '\n\n' + COZY_MODE_CONTENT
    : COZY_MODE_CONTENT;
  await window.cozyPane.fs.writefile(claudeMdPath, newContent);
}

export async function disableCozyMode(cwd: string): Promise<void> {
  const claudeMdPath = cwd + '/CLAUDE.md';
  const result = await window.cozyPane.fs.readfile(claudeMdPath);
  if (!result.content || !result.content.includes(COZY_MODE_MARKER)) return;

  const markerIdx = result.content.indexOf(COZY_MODE_MARKER);
  const remaining = result.content.slice(0, markerIdx).trimEnd();

  if (remaining.length === 0) {
    await window.cozyPane.fs.writefile(claudeMdPath, '');
  } else {
    await window.cozyPane.fs.writefile(claudeMdPath, remaining + '\n');
  }
}
