import { app, BrowserWindow, dialog, ipcMain, shell, session } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { JobStartRequest, JobStartResponse, WorkerEvent } from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/contracts";

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let mainWindow: BrowserWindow | null = null;
let activeWorker: Worker | null = null;
let activeJobId: string | null = null;

const WORKER_PATH = path.join(__dirname, "workers", "processor.worker.js");
const RENDERER_INDEX = path.join(__dirname, "..", "..", "dist", "renderer", "index.html");

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
        "Content-Security-Policy": [isDev ? cspDev : cspProd]
      }
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
    title: "Consulta Simples Nacional",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (url !== currentUrl) {
      event.preventDefault();
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  if (isDev) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    void window.loadFile(RENDERER_INDEX);
  }

  return window;
}

function validateJobRequest(input: unknown): JobStartRequest {
  if (!input || typeof input !== "object") {
    throw new Error("Payload invalido para iniciar processamento.");
  }

  const data = input as Partial<JobStartRequest>;
  const delaySeconds = Number(data.delaySeconds);
  const workers = Number(data.workers);
  const reprocessRounds = Number(data.reprocessRounds);
  const rawMaxRows = data.maxRows;

  if (typeof data.inputFile !== "string" || data.inputFile.trim().length === 0) {
    throw new Error("Arquivo de entrada invalido.");
  }
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    throw new Error("Delay invalido.");
  }
  if (!Number.isInteger(workers) || workers <= 0 || workers > 32) {
    throw new Error("Workers invalidos.");
  }
  if (!Number.isInteger(reprocessRounds) || reprocessRounds < 0 || reprocessRounds > 10) {
    throw new Error("Rodadas de reprocessamento invalidas.");
  }

  let maxRows: number | null = null;
  if (rawMaxRows !== null && rawMaxRows !== undefined) {
    const parsed = Number(rawMaxRows);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("Limite de linhas invalido.");
    }
    maxRows = parsed;
  }

  return {
    inputFile: data.inputFile,
    delaySeconds,
    maxRows,
    workers,
    reprocessRounds
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
      title: "Selecione a planilha XLSX",
      properties: ["openFile"],
      filters: [{ name: "Excel", extensions: ["xlsx"] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.startJob, async (_event, payload: unknown): Promise<JobStartResponse> => {
    if (activeWorker || activeJobId) {
      throw new Error("Ja existe um processamento em andamento.");
    }

    const request = validateJobRequest(payload);
    const jobId = randomUUID();
    const worker = new Worker(WORKER_PATH, { workerData: request });

    activeWorker = worker;
    activeJobId = jobId;

    worker.on("message", (message: WorkerEvent) => {
      sendJobEvent(message);
      if (message.type === "done" || message.type === "error") {
        clearActiveJob();
      }
    });

    worker.on("error", (error: Error) => {
      sendJobEvent({ type: "error", message: error.message });
      clearActiveJob();
    });

    worker.on("exit", (code: number) => {
      if (activeWorker === worker && code !== 0) {
        sendJobEvent({ type: "error", message: `Worker encerrado com codigo ${code}.` });
        clearActiveJob();
      }
    });

    return { jobId };
  });

  ipcMain.handle(IPC_CHANNELS.stopJob, async (): Promise<boolean> => {
    if (!activeWorker) {
      return false;
    }
    activeWorker.postMessage({ type: "stop" });
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.openPath, async (_event, targetPath: unknown): Promise<string> => {
    if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
      throw new Error("Caminho invalido.");
    }
    return shell.openPath(targetPath);
  });
}

app.whenReady().then(() => {
  setupSecurityHeaders();
  setupIpcHandlers();
  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (activeWorker) {
    activeWorker.postMessage({ type: "stop" });
  }
});
