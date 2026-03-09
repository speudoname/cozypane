// Map file extensions to Monaco language IDs
export function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', mdx: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    yaml: 'yaml', yml: 'yaml',
    toml: 'ini',
    xml: 'xml', svg: 'xml',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql',
    graphql: 'graphql', gql: 'graphql',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    env: 'ini',
  };
  return map[ext] || 'plaintext';
}
