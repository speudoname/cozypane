const COZY_MODE_MARKER = '<!-- COZY_MODE: managed by CozyPane -->';

const COZY_MODE_CONTENT = `${COZY_MODE_MARKER}
# CozyPane Deploy

Say "cozydeploy" to deploy. The platform auto-detects framework, port, and database — no Dockerfile needed.

For multi-service apps: deploy each service separately with a shared \`group\` name, backends first.
Pass inter-service URLs via \`env\` (e.g. \`{"API_URL": "https://myapi-user.cozypane.com"}\`).

If deploy fails, use \`cozypane_get_logs\` with type="build" to diagnose.
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
