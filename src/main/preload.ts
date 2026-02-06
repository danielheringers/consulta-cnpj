import { contextBridge, ipcRenderer } from "electron";
import type { BridgeApi, JobStartRequest, JobStartResponse, WorkerEvent } from "../shared/contracts";

// Keep preload runtime self-contained for sandbox mode.
const IPC_CHANNELS = {
  selectFile: "dialog:select-xlsx",
  startJob: "job:start",
  stopJob: "job:stop",
  openPath: "shell:open-path",
  jobEvent: "job:event"
} as const;

const api: BridgeApi = {
  selectXlsxFile: async (): Promise<string | null> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.selectFile);
    return typeof result === "string" ? result : null;
  },
  startJob: async (request: JobStartRequest): Promise<JobStartResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.startJob, request);
  },
  stopJob: async (): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.stopJob);
  },
  openPath: async (targetPath: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.openPath, targetPath);
  },
  onJobEvent: (handler: (event: WorkerEvent) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: WorkerEvent) => {
      handler(event);
    };
    ipcRenderer.on(IPC_CHANNELS.jobEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.jobEvent, listener);
    };
  }
};

contextBridge.exposeInMainWorld("consultaSimples", api);
