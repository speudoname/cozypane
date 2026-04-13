// Electron mock for Vitest — stubs all commonly used Electron APIs

export const app = {
  getPath: vi.fn().mockReturnValue('/tmp/mock-user-data'),
  getVersion: vi.fn().mockReturnValue('0.0.0-test'),
  isPackaged: false,
  getName: vi.fn().mockReturnValue('CozyPane'),
  quit: vi.fn(),
  on: vi.fn(),
  whenReady: vi.fn().mockResolvedValue(undefined),
  requestSingleInstanceLock: vi.fn().mockReturnValue(true),
  setAsDefaultProtocolClient: vi.fn(),
};

export const ipcMain = {
  handle: vi.fn(),
  on: vi.fn(),
  removeHandler: vi.fn(),
};

export const BrowserWindow = vi.fn().mockImplementation(() => ({
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
  webContents: {
    send: vi.fn(),
    on: vi.fn(),
    openDevTools: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
  },
  isDestroyed: vi.fn().mockReturnValue(false),
  setTitle: vi.fn(),
  getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 }),
  setBounds: vi.fn(),
}));
(BrowserWindow as any).getAllWindows = vi.fn().mockReturnValue([]);
(BrowserWindow as any).getFocusedWindow = vi.fn().mockReturnValue(null);

export const dialog = {
  showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
  showSaveDialog: vi.fn().mockResolvedValue({ canceled: true, filePath: '' }),
  showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  showErrorBox: vi.fn(),
};

export const shell = {
  openExternal: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(''),
  showItemInFolder: vi.fn(),
};

export const safeStorage = {
  isEncryptionAvailable: vi.fn().mockReturnValue(true),
  encryptString: vi.fn().mockImplementation((text: string) => Buffer.from(`encrypted:${text}`)),
  decryptString: vi.fn().mockImplementation((buffer: Buffer) => {
    const str = buffer.toString();
    return str.startsWith('encrypted:') ? str.slice('encrypted:'.length) : str;
  }),
};

export const clipboard = {
  readText: vi.fn().mockReturnValue(''),
  writeText: vi.fn(),
  readImage: vi.fn(),
  readFilePaths: vi.fn().mockReturnValue([]),
};

export const nativeImage = {
  createFromPath: vi.fn().mockReturnValue({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
  createFromBuffer: vi.fn().mockReturnValue({ isEmpty: () => true }),
  createEmpty: vi.fn().mockReturnValue({ isEmpty: () => true }),
};

export const session = {
  defaultSession: {
    webRequest: { onBeforeSendHeaders: vi.fn() },
    clearStorageData: vi.fn(),
  },
};

export const protocol = {
  registerFileProtocol: vi.fn(),
  registerStringProtocol: vi.fn(),
  handle: vi.fn(),
};

export const Menu = {
  buildFromTemplate: vi.fn().mockReturnValue({ popup: vi.fn() }),
  setApplicationMenu: vi.fn(),
};

export const Tray = vi.fn().mockImplementation(() => ({
  setToolTip: vi.fn(),
  setContextMenu: vi.fn(),
  on: vi.fn(),
  destroy: vi.fn(),
}));

export const net = {
  request: vi.fn(),
  fetch: vi.fn(),
};

export const WebContents = {};

export default {
  app,
  ipcMain,
  BrowserWindow,
  dialog,
  shell,
  safeStorage,
  clipboard,
  nativeImage,
  session,
  protocol,
  Menu,
  Tray,
  net,
  WebContents,
};
