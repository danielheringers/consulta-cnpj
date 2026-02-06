import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  session,
  shell,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  JobStartRequest,
  JobStartResponse,
  WorkerEvent,
} from '../shared/contracts';
import { IPC_CHANNELS } from '../shared/contracts';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let activeWorker: Worker | null = null;
let activeJobId: string | null = null;

const WORKER_PATH = path.join(__dirname, 'workers', 'processor.worker.js');
const RENDERER_INDEX = path.join(
  __dirname,
  '..',
  '..',
  'dist',
  'renderer',
  'index.html',
);
const DEV_WINDOW_ICON = path.join(
  process.cwd(),
  'src',
  'renderer',
  'public',
  'icon.png',
);
const PROD_WINDOW_ICON = path.join(
  __dirname,
  '..',
  '..',
  'dist',
  'renderer',
  'icon.png',
);
const DEV_SPLASH_LOGO = path.join(
  process.cwd(),
  'src',
  'renderer',
  'public',
  'logo.png',
);
const PROD_SPLASH_LOGO = path.join(
  __dirname,
  '..',
  '..',
  'dist',
  'renderer',
  'logo.png',
);
const SPLASH_MIN_DURATION_MS = 1400;
const MAIN_READY_TIMEOUT_MS = 15000;

function getWindowIconPath(): string {
  return isDev ? DEV_WINDOW_ICON : PROD_WINDOW_ICON;
}

function getSplashLogoPath(): string {
  return isDev ? DEV_SPLASH_LOGO : PROD_SPLASH_LOGO;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSplashHtml(logoDataUrl: string): string {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Carregando</title>
    <style>
      * { box-sizing: border-box; }
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }
      body {
        display: grid;
        place-items: center;
        font-family: "Segoe UI", "Trebuchet MS", sans-serif;
      }
      .stage {
        position: relative;
        width: 420px;
        height: 260px;
        display: grid;
        place-items: center;
      }
      .glow {
        position: absolute;
        width: 290px;
        height: 160px;
        border-radius: 50%;
        background: radial-gradient(circle at 50% 45%, rgba(117, 240, 224, 0.45) 0%, rgba(34, 128, 196, 0.22) 52%, rgba(10, 16, 28, 0) 75%);
        filter: blur(15px);
        opacity: 0;
        transform: scale(0.84);
        animation: glowIn 1050ms cubic-bezier(0.2, 0.9, 0.3, 1) forwards;
      }
      .logo-wrap {
        position: relative;
        display: inline-grid;
        place-items: center;
        transform-origin: center center;
        animation: logoIn 1200ms cubic-bezier(0.17, 1, 0.28, 1) forwards;
      }
      .logo {
        width: 340px;
        max-width: 75vw;
        height: auto;
        display: block;
        user-select: none;
        -webkit-user-drag: none;
        filter: drop-shadow(0 14px 30px rgba(3, 12, 28, 0.45));
      }
      .shine {
        position: absolute;
        inset: 0;
        overflow: hidden;
        border-radius: 12px;
        mix-blend-mode: screen;
        pointer-events: none;
      }
      .shine::after {
        content: "";
        position: absolute;
        top: -25%;
        left: -42%;
        width: 34%;
        height: 150%;
        transform: skewX(-18deg);
        background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(186,235,255,0.45) 42%, rgba(255,255,255,0.9) 50%, rgba(255,255,255,0) 100%);
        animation: shinePass 900ms ease-in-out 240ms forwards;
      }
      @keyframes glowIn {
        0% { opacity: 0; transform: scale(0.84); }
        55% { opacity: 0.7; transform: scale(1.03); }
        100% { opacity: 0.42; transform: scale(1); }
      }
      @keyframes logoIn {
        0% { opacity: 0; transform: translateY(14px) scale(0.9); filter: blur(6px); }
        65% { opacity: 1; transform: translateY(-1px) scale(1.02); filter: blur(0px); }
        100% { opacity: 1; transform: translateY(0px) scale(1); filter: blur(0px); }
      }
      @keyframes shinePass {
        from { transform: translateX(0%) skewX(-18deg); }
        to { transform: translateX(410%) skewX(-18deg); }
      }
    </style>
  </head>
  <body>
    <div class="stage" aria-label="Carregando app">
      <div class="glow" aria-hidden="true"></div>
      <div class="logo-wrap">
        <img class="logo" src="${logoDataUrl}" alt="Consulta CNPJ" />
        <span class="shine" aria-hidden="true"></span>
      </div>
    </div>
  </body>
</html>`;
}

function setupSecurityHeaders(): void {
  const cspProd =
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "frame-ancestors 'none'";

  const cspDev =
    "default-src 'self' http://localhost:5173 ws://localhost:5173 data:; " +
    "script-src 'self' http://localhost:5173 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline' http://localhost:5173; " +
    "img-src 'self' data: blob: http://localhost:5173; " +
    "connect-src 'self' http://localhost:5173 ws://localhost:5173";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [isDev ? cspDev : cspProd],
      },
    });
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: '4tax Fiscal Cloud - Consulta Simples Nacional',
    icon: getWindowIconPath(),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.removeMenu();
  window.webContents.on('will-navigate', (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (url !== currentUrl) {
      event.preventDefault();
    }
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (isDev) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    void window.loadFile(RENDERER_INDEX);
  }

  return window;
}

function createSplashWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 480,
    height: 290,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const logoBase64 = readFileSync(getSplashLogoPath()).toString('base64');
  const logoDataUrl = `data:image/png;base64,${logoBase64}`;
  const splashHtml = buildSplashHtml(logoDataUrl);
  void window.loadURL(
    `data:text/html;charset=UTF-8,${encodeURIComponent(splashHtml)}`,
  );

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.showInactive();
    }
  });

  window.on('closed', () => {
    if (splashWindow === window) {
      splashWindow = null;
    }
  });

  return window;
}

function waitForMainReady(window: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (window.isDestroyed()) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    const timeout = setTimeout(finish, MAIN_READY_TIMEOUT_MS);
    window.once('ready-to-show', finish);
    window.webContents.once('did-finish-load', finish);
    window.webContents.once('did-fail-load', finish);
  });
}

async function revealMainWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const currentMain = mainWindow;
  await Promise.all([
    waitForMainReady(currentMain),
    wait(SPLASH_MIN_DURATION_MS),
  ]);

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
  }

  if (!currentMain.isDestroyed()) {
    currentMain.show();
    currentMain.focus();
  }
}

function validateJobRequest(input: unknown): JobStartRequest {
  if (!input || typeof input !== 'object') {
    throw new Error('Payload invalido para iniciar processamento.');
  }

  const data = input as Partial<JobStartRequest>;
  const delaySeconds = Number(data.delaySeconds);
  const workers = Number(data.workers);
  const reprocessRounds = Number(data.reprocessRounds);
  const rawMaxRows = data.maxRows;

  if (
    typeof data.inputFile !== 'string' ||
    data.inputFile.trim().length === 0
  ) {
    throw new Error('Arquivo de entrada invalido.');
  }
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    throw new Error('Delay invalido.');
  }
  if (!Number.isInteger(workers) || workers <= 0 || workers > 32) {
    throw new Error('Workers invalidos.');
  }
  if (
    !Number.isInteger(reprocessRounds) ||
    reprocessRounds < 0 ||
    reprocessRounds > 10
  ) {
    throw new Error('Rodadas de reprocessamento invalidas.');
  }

  let maxRows: number | null = null;
  if (rawMaxRows !== null && rawMaxRows !== undefined) {
    const parsed = Number(rawMaxRows);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error('Limite de linhas invalido.');
    }
    maxRows = parsed;
  }

  return {
    inputFile: data.inputFile,
    delaySeconds,
    maxRows,
    workers,
    reprocessRounds,
  };
}

function sendJobEvent(event: WorkerEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.jobEvent, event);
  }
}

function clearActiveJob(): void {
  if (activeWorker) {
    activeWorker.removeAllListeners();
  }
  activeWorker = null;
  activeJobId = null;
}

function setupIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.selectFile, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Selecione a planilha XLSX',
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(
    IPC_CHANNELS.startJob,
    async (_event, payload: unknown): Promise<JobStartResponse> => {
      if (activeWorker || activeJobId) {
        throw new Error('Ja existe um processamento em andamento.');
      }

      const request = validateJobRequest(payload);
      const jobId = randomUUID();
      const worker = new Worker(WORKER_PATH, { workerData: request });

      activeWorker = worker;
      activeJobId = jobId;

      worker.on('message', (message: WorkerEvent) => {
        sendJobEvent(message);
        if (message.type === 'done' || message.type === 'error') {
          clearActiveJob();
        }
      });

      worker.on('error', (error: Error) => {
        sendJobEvent({ type: 'error', message: error.message });
        clearActiveJob();
      });

      worker.on('exit', (code: number) => {
        if (activeWorker === worker && code !== 0) {
          sendJobEvent({
            type: 'error',
            message: `Worker encerrado com codigo ${code}.`,
          });
          clearActiveJob();
        }
      });

      return { jobId };
    },
  );

  ipcMain.handle(IPC_CHANNELS.stopJob, async (): Promise<boolean> => {
    if (!activeWorker) {
      return false;
    }
    activeWorker.postMessage({ type: 'stop' });
    return true;
  });

  ipcMain.handle(
    IPC_CHANNELS.openPath,
    async (_event, targetPath: unknown): Promise<string> => {
      if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
        throw new Error('Caminho invalido.');
      }
      return shell.openPath(targetPath);
    },
  );
}

app.whenReady().then(() => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  setupSecurityHeaders();
  setupIpcHandlers();
  mainWindow = createMainWindow();
  splashWindow = createSplashWindow();
  void revealMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      mainWindow.once('ready-to-show', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
        }
      });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (activeWorker) {
    activeWorker.postMessage({ type: 'stop' });
  }
});
