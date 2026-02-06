export const IPC_CHANNELS = {
  selectFile: "dialog:select-xlsx",
  startJob: "job:start",
  stopJob: "job:stop",
  openPath: "shell:open-path",
  jobEvent: "job:event"
} as const;

export type QueryStatus = "SIM" | "NAO" | "SEM_DADO" | "ERRO" | "CNPJ_INVALIDO" | "PENDENTE";

export interface JobStartRequest {
  inputFile: string;
  delaySeconds: number;
  maxRows: number | null;
  workers: number;
  reprocessRounds: number;
}

export interface JobStartResponse {
  jobId: string;
}

export interface ProcessResult {
  outputFile: string;
  processed: number;
  total: number;
  success: number;
  failed: number;
  semDado: number;
  erro: number;
  invalid: number;
  interrupted: boolean;
  reportFile: string;
}

export interface QueryOutcome {
  status: QueryStatus | "ERRO";
  detail: string;
  provider: string;
}

export interface LogEvent {
  type: "log";
  message: string;
}

export interface ProgressEvent {
  type: "progress";
  done: number;
  total: number;
}

export interface DoneEvent {
  type: "done";
  result: ProcessResult;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type WorkerEvent = LogEvent | ProgressEvent | DoneEvent | ErrorEvent;

export interface WorkerControlMessage {
  type: "stop";
}

export interface BridgeApi {
  selectXlsxFile: () => Promise<string | null>;
  startJob: (request: JobStartRequest) => Promise<JobStartResponse>;
  stopJob: () => Promise<boolean>;
  openPath: (targetPath: string) => Promise<string>;
  onJobEvent: (handler: (event: WorkerEvent) => void) => () => void;
}
