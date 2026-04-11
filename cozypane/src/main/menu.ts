import { app, Menu, shell, BrowserWindow } from 'electron';

// Electron application menu template, extracted from main.ts to keep the
// main-process entry file focused on window/lifecycle wiring. All menu
// items that trigger renderer-side behavior go through `menu:*` IPC
// channels which the renderer subscribes to via
// `window.cozyPane.onMenuAction('menu:...', cb)`. See H20 audit finding.

export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin';
  const send = (channel: string) => () => getWindow()?.webContents.send(channel);

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        {
          label: 'Settings...',
          accelerator: 'Cmd+,' as const,
          click: send('menu:settings'),
        },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        ...(isMac ? [
          { type: 'separator' as const },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' as const },
              { role: 'stopSpeaking' as const },
            ],
          },
        ] : []),
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: send('menu:new-tab'),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: send('menu:close-tab'),
        },
        { type: 'separator' },
        {
          label: 'Split View',
          click: send('menu:split-view'),
        },
        {
          label: 'Clear Terminal',
          accelerator: 'CmdOrCtrl+K',
          click: send('menu:clear-terminal'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Panels',
          accelerator: 'CmdOrCtrl+B',
          click: send('menu:toggle-panels'),
        },
        {
          label: 'Switch Layout',
          click: send('menu:toggle-layout'),
        },
        { type: 'separator' },
        {
          label: 'Zoom In (Focused Panel)',
          accelerator: 'CmdOrCtrl+=',
          click: send('menu:zoom-in'),
        },
        {
          label: 'Zoom Out (Focused Panel)',
          accelerator: 'CmdOrCtrl+-',
          click: send('menu:zoom-out'),
        },
        {
          label: 'Reset Zoom (Focused Panel)',
          accelerator: 'CmdOrCtrl+0',
          click: send('menu:zoom-reset'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' as const },
        { role: 'toggleDevTools' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'CozyPane Website',
          click: () => shell.openExternal('https://cozypane.com'),
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal('https://github.com/speudoname/cozypane/issues'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
