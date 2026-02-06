import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type {
  JobStartRequest,
  ProcessResult,
  QueryOutcome,
  WorkerControlMessage,
  WorkerEvent,
} from '../../shared/contracts';

const CACHE_FILE = 'cache_simples_nacional.json';
const HEADER_CNPJ = 'CRITERIO DE PESQUISA 1';
const HEADER_RESULT = 'SIMPLES NACIONAL';
const DEFAULT_TIMEOUT_SECONDS = 8;
const MIN_DELAY_SECONDS = 0.1;
const PROVIDERS_FALLBACK = [
  'receitaws',
  'minhareceita',
  'brasilapi',
  'cnpjws',
] as const;
const PROVIDER_RATE_FACTORS: Record<
  (typeof PROVIDERS_FALLBACK)[number],
  number
> = {
  receitaws: 1.0,
  minhareceita: 0.4,
  brasilapi: 0.4,
  cnpjws: 0.7,
};
const REPORT_SUFFIX = '_log_detalhado.csv';
const PROVIDER_FAILURE_THRESHOLD = 4;
const PROVIDER_COOLDOWN_SECONDS = 45;
const ROUND_PROGRESS_STEP = 10;
const ROUND_HEARTBEAT_SECONDS = 5;
const MAX_RETRIES = 2;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

type ProviderName = (typeof PROVIDERS_FALLBACK)[number];
type QueryState = 'SIM' | 'NÃO' | 'ERRO';

interface ReportEntry {
  linha: string;
  cnpj_original: string;
  cnpj_limpo: string;
  resultado: string;
  origem: string;
  provedor: string;
  detalhe: string;
}

class StopRequestedError extends Error {
  constructor() {
    super('Processamento interrompido pelo usuario.');
    this.name = 'StopRequestedError';
  }
}

let stopRequested = false;
const inflightControllers = new Set<AbortController>();

parentPort?.on('message', (message: WorkerControlMessage) => {
  if (message && message.type === 'stop') {
    stopRequested = true;
    for (const controller of inflightControllers) {
      controller.abort();
    }
  }
});

function postEvent(event: WorkerEvent): void {
  parentPort?.postMessage(event);
}

function log(message: string): void {
  postEvent({ type: 'log', message });
}

function reportProgress(done: number, total: number): void {
  postEvent({ type: 'progress', done, total });
}

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value).trim();
  if (!text) {
    return '';
  }
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeCnpj(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 14 ? digits : '';
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const rem = total % 3600;
  const minutes = Math.floor(rem / 60);
  const secs = rem % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

async function sleepInterruptible(seconds: number): Promise<void> {
  let remaining = Math.max(seconds, 0) * 1000;
  while (remaining > 0) {
    if (stopRequested) {
      throw new StopRequestedError();
    }
    const step = Math.min(250, remaining);
    await new Promise((resolve) => setTimeout(resolve, step));
    remaining -= step;
  }
}

function toJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toCellString(value: ExcelJS.CellValue | undefined | null): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text ?? '').join('');
    }
    if ('text' in value && typeof value.text === 'string') {
      return value.text;
    }
    if (
      'result' in value &&
      (typeof value.result === 'string' ||
        typeof value.result === 'number' ||
        typeof value.result === 'boolean')
    ) {
      return String(value.result);
    }
    if ('formula' in value && typeof value.formula === 'string') {
      return value.formula;
    }
  }
  return String(value);
}

function buildOutputPath(inputPath: string): string {
  const parsed = path.parse(inputPath);
  const now = new Date();
  const stamp =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  return path.join(
    parsed.dir,
    `${parsed.name}_simples_atualizado_${stamp}${parsed.ext}`,
  );
}

function buildReportPath(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}${REPORT_SUFFIX}`);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function writeDetailedReport(
  reportPath: string,
  entries: ReportEntry[],
): Promise<void> {
  const headers = [
    'linha',
    'cnpj_original',
    'cnpj_limpo',
    'resultado',
    'origem',
    'provedor',
    'detalhe',
  ];
  const sorted = [...entries].sort(
    (a, b) => Number.parseInt(a.linha, 10) - Number.parseInt(b.linha, 10),
  );
  const lines = [headers.join(',')];
  for (const entry of sorted) {
    const row = headers.map((header) =>
      csvEscape(entry[header as keyof ReportEntry]),
    );
    lines.push(row.join(','));
  }
  await fs.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf-8');
}

async function loadCache(
  cachePath: string,
): Promise<Record<string, 'SIM' | 'NÃO'>> {
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, 'SIM' | 'NÃO'> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if ((value === 'SIM' || value === 'NÃO') && typeof key === 'string') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function saveCache(
  cachePath: string,
  cache: Record<string, string>,
): Promise<void> {
  const data: Record<string, 'SIM' | 'NÃO'> = {};
  for (const [key, value] of Object.entries(cache)) {
    if (value === 'SIM' || value === 'NÃO') {
      data[key] = value;
    }
  }
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2), 'utf-8');
}

class ProviderRateLimiter {
  private readonly baseDelaySeconds: number;
  private readonly nextAllowed = new Map<ProviderName, number>();

  constructor(baseDelaySeconds: number) {
    this.baseDelaySeconds = Math.max(baseDelaySeconds, MIN_DELAY_SECONDS);
  }

  async waitTurn(provider: ProviderName): Promise<void> {
    const factor = PROVIDER_RATE_FACTORS[provider] ?? 1.0;
    const interval = Math.max(
      this.baseDelaySeconds * factor,
      MIN_DELAY_SECONDS,
    );

    while (true) {
      if (stopRequested) {
        throw new StopRequestedError();
      }
      const now = Date.now();
      const nextAllowed = this.nextAllowed.get(provider) ?? 0;
      if (now >= nextAllowed) {
        this.nextAllowed.set(provider, now + interval * 1000);
        return;
      }
      const waitFor = Math.min(nextAllowed - now, 250);
      await new Promise((resolve) => setTimeout(resolve, waitFor));
    }
  }
}

class SimplesApiClient {
  private readonly timeoutSeconds: number;
  private readonly maxRetries: number;
  private readonly rateLimiter: ProviderRateLimiter;
  private readonly providerFailures = new Map<ProviderName, number>();
  private readonly providerCooldownUntil = new Map<ProviderName, number>();

  constructor(
    delaySeconds: number,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    maxRetries = MAX_RETRIES,
  ) {
    this.timeoutSeconds = timeoutSeconds;
    this.maxRetries = Math.max(1, maxRetries);
    this.rateLimiter = new ProviderRateLimiter(delaySeconds);
  }

  private providerCooldownRemaining(providerName: ProviderName): number {
    const now = Date.now();
    const cooldownUntil = this.providerCooldownUntil.get(providerName) ?? 0;
    if (cooldownUntil <= now) {
      return 0;
    }
    return (cooldownUntil - now) / 1000;
  }

  private recordProviderSuccess(providerName: ProviderName): void {
    this.providerFailures.set(providerName, 0);
    this.providerCooldownUntil.delete(providerName);
  }

  private recordProviderFailure(providerName: ProviderName): number | null {
    const failures = (this.providerFailures.get(providerName) ?? 0) + 1;
    if (failures >= PROVIDER_FAILURE_THRESHOLD) {
      const cooldownUntil = Date.now() + PROVIDER_COOLDOWN_SECONDS * 1000;
      this.providerFailures.set(providerName, 0);
      this.providerCooldownUntil.set(providerName, cooldownUntil);
      return PROVIDER_COOLDOWN_SECONDS;
    }
    this.providerFailures.set(providerName, failures);
    return null;
  }

  private async requestJson(
    providerName: ProviderName,
    url: string,
  ): Promise<[Record<string, unknown> | null, string | null]> {
    let lastError = '';

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      if (stopRequested) {
        throw new StopRequestedError();
      }

      const cooldownRemaining = this.providerCooldownRemaining(providerName);
      if (cooldownRemaining > 0) {
        return [
          null,
          `${providerName}: provedor pausado (${Math.floor(cooldownRemaining)}s restantes apos falhas consecutivas)`,
        ];
      }

      await this.rateLimiter.waitTurn(providerName);

      const controller = new AbortController();
      inflightControllers.add(controller);
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.timeoutSeconds * 1000,
      );

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (response.status === 429) {
          const cooldown = this.recordProviderFailure(providerName);
          if (cooldown) {
            return [
              null,
              `${providerName}: pausado por ${cooldown}s por limite de requisicoes (429)`,
            ];
          }
          return [null, `${providerName}: limite de requisicoes (429)`];
        }

        if (response.status >= 500) {
          lastError = `erro no servidor (${response.status})`;
          const cooldown = this.recordProviderFailure(providerName);
          if (cooldown) {
            return [
              null,
              `${providerName}: pausado por ${cooldown}s por erros consecutivos no servidor`,
            ];
          }
          await sleepInterruptible(Math.min(2 * attempt, 4));
          continue;
        }

        if (response.status !== 200) {
          return [null, `${providerName}: HTTP ${response.status}`];
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          const cooldown = this.recordProviderFailure(providerName);
          if (cooldown) {
            return [
              null,
              `${providerName}: pausado por ${cooldown}s por respostas invalidas consecutivas`,
            ];
          }
          return [null, `${providerName}: resposta invalida`];
        }

        const parsed = toJsonRecord(payload);
        if (!parsed) {
          const cooldown = this.recordProviderFailure(providerName);
          if (cooldown) {
            return [
              null,
              `${providerName}: pausado por ${cooldown}s por payload inesperado consecutivo`,
            ];
          }
          return [null, `${providerName}: payload inesperado`];
        }

        this.recordProviderSuccess(providerName);
        return [parsed, null];
      } catch (error) {
        if (stopRequested) {
          throw new StopRequestedError();
        }
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        lastError = `falha de rede: ${errorMessage}`;
        const cooldown = this.recordProviderFailure(providerName);
        if (cooldown) {
          return [
            null,
            `${providerName}: pausado por ${cooldown}s por falhas consecutivas de rede`,
          ];
        }
        await sleepInterruptible(Math.min(2 * attempt, 4));
      } finally {
        clearTimeout(timeoutId);
        inflightControllers.delete(controller);
      }
    }

    this.recordProviderFailure(providerName);
    return [null, `${providerName}: ${lastError || 'falha sem detalhe'}`];
  }

  private parseGenericSimples(
    payload: Record<string, unknown>,
    providerName: ProviderName,
  ): QueryOutcome {
    const simples = payload.simples;
    const simplesObject = toJsonRecord(simples);
    if (simplesObject && typeof simplesObject.optante === 'boolean') {
      if (simplesObject.optante) {
        return {
          status: 'SIM',
          detail: `${providerName}: simples.optante=true`,
          provider: providerName,
        };
      }
      return {
        status: 'NÃO',
        detail: `${providerName}: simples.optante=false`,
        provider: providerName,
      };
    }
    if (typeof simples === 'boolean') {
      if (simples) {
        return {
          status: 'SIM',
          detail: `${providerName}: simples=true`,
          provider: providerName,
        };
      }
      return {
        status: 'NÃO',
        detail: `${providerName}: simples=false`,
        provider: providerName,
      };
    }

    const opcao = payload.opcao_pelo_simples;
    if (typeof opcao === 'boolean') {
      if (opcao) {
        return {
          status: 'SIM',
          detail: `${providerName}: opcao_pelo_simples=true`,
          provider: providerName,
        };
      }
      return {
        status: 'NÃO',
        detail: `${providerName}: opcao_pelo_simples=false`,
        provider: providerName,
      };
    }

    const opcaoAlt = payload.opcao_simples;
    if (typeof opcaoAlt === 'boolean') {
      if (opcaoAlt) {
        return {
          status: 'SIM',
          detail: `${providerName}: opcao_simples=true`,
          provider: providerName,
        };
      }
      return {
        status: 'NÃO',
        detail: `${providerName}: opcao_simples=false`,
        provider: providerName,
      };
    }

    const regime = payload.regime_tributario;
    if (Array.isArray(regime) && regime.length > 0) {
      const formas = regime
        .map((item) => toJsonRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => String(item.forma_de_tributacao ?? '').toUpperCase());

      if (formas.some((forma) => forma.includes('SIMPLES'))) {
        return {
          status: 'SIM',
          detail: `${providerName}: regime_tributario=simples`,
          provider: providerName,
        };
      }
      return {
        status: 'NÃO',
        detail: `${providerName}: regime_tributario sem simples`,
        provider: providerName,
      };
    }

    return {
      status: 'NÃO',
      detail: `${providerName}: campo de simples NÃO retornado`,
      provider: providerName,
    };
  }

  private async consultarReceitaWs(cnpj: string): Promise<QueryOutcome> {
    const [payload, error] = await this.requestJson(
      'receitaws',
      `https://www.receitaws.com.br/v1/cnpj/${cnpj}`,
    );
    if (error) {
      return { status: 'ERRO', detail: error, provider: 'receitaws' };
    }
    if (!payload) {
      return {
        status: 'ERRO',
        detail: 'receitaws: sem payload',
        provider: 'receitaws',
      };
    }
    if (payload.status === 'ERROR') {
      const message = payload.message
        ? String(payload.message)
        : 'erro na consulta';
      return {
        status: 'ERRO',
        detail: `receitaws: ${message}`,
        provider: 'receitaws',
      };
    }
    return this.parseGenericSimples(payload, 'receitaws');
  }

  private async consultarMinhaReceita(cnpj: string): Promise<QueryOutcome> {
    const [payload, error] = await this.requestJson(
      'minhareceita',
      `https://minhareceita.org/${cnpj}`,
    );
    if (error) {
      return { status: 'ERRO', detail: error, provider: 'minhareceita' };
    }
    if (!payload) {
      return {
        status: 'ERRO',
        detail: 'minhareceita: sem payload',
        provider: 'minhareceita',
      };
    }
    return this.parseGenericSimples(payload, 'minhareceita');
  }

  private async consultarBrasilApi(cnpj: string): Promise<QueryOutcome> {
    const [payload, error] = await this.requestJson(
      'brasilapi',
      `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
    );
    if (error) {
      return { status: 'ERRO', detail: error, provider: 'brasilapi' };
    }
    if (!payload) {
      return {
        status: 'ERRO',
        detail: 'brasilapi: sem payload',
        provider: 'brasilapi',
      };
    }
    return this.parseGenericSimples(payload, 'brasilapi');
  }

  private async consultarCnpjWs(cnpj: string): Promise<QueryOutcome> {
    const [payload, error] = await this.requestJson(
      'cnpjws',
      `https://publica.cnpj.ws/cnpj/${cnpj}`,
    );
    if (error) {
      return { status: 'ERRO', detail: error, provider: 'cnpjws' };
    }
    if (!payload) {
      return {
        status: 'ERRO',
        detail: 'cnpjws: sem payload',
        provider: 'cnpjws',
      };
    }
    return this.parseGenericSimples(payload, 'cnpjws');
  }

  async consultarSimples(cnpj: string): Promise<QueryOutcome> {
    const errors: QueryOutcome[] = [];
    const providers: Record<
      ProviderName,
      (cnpjToQuery: string) => Promise<QueryOutcome>
    > = {
      receitaws: async (targetCnpj) => this.consultarReceitaWs(targetCnpj),
      minhareceita: async (targetCnpj) =>
        this.consultarMinhaReceita(targetCnpj),
      brasilapi: async (targetCnpj) => this.consultarBrasilApi(targetCnpj),
      cnpjws: async (targetCnpj) => this.consultarCnpjWs(targetCnpj),
    };

    for (const providerName of PROVIDERS_FALLBACK) {
      if (stopRequested) {
        throw new StopRequestedError();
      }
      const outcome = await providers[providerName](cnpj);
      if (outcome.status === 'SIM' || outcome.status === 'NÃO') {
        return outcome;
      }
      errors.push(outcome);
    }

    const detail =
      errors.length > 0
        ? errors
            .slice(0, 4)
            .map((item) => item.detail)
            .join(' | ')
        : 'falha sem detalhe';
    return { status: 'ERRO', detail, provider: 'fallback' };
  }
}

function findTargetSheet(workbook: ExcelJS.Workbook): {
  sheet: ExcelJS.Worksheet;
  cnpjCol: number;
  resultCol: number;
} {
  for (const sheet of workbook.worksheets) {
    const headers = new Map<string, number>();
    const colCount = Math.max(sheet.columnCount, sheet.actualColumnCount);
    for (let col = 1; col <= colCount; col += 1) {
      const normalized = normalizeText(
        toCellString(sheet.getCell(1, col).value),
      );
      if (normalized) {
        headers.set(normalized, col);
      }
    }
    const cnpjCol = headers.get(HEADER_CNPJ);
    const resultCol = headers.get(HEADER_RESULT);
    if (cnpjCol && resultCol) {
      return { sheet, cnpjCol, resultCol };
    }
  }
  throw new Error(
    "NÃO encontrei uma aba com as colunas 'Criterio de pesquisa 1' e 'SIMPLES NACIONAL' na linha 1.",
  );
}

function setSheetValue(
  sheet: ExcelJS.Worksheet,
  row: number,
  column: number,
  value: string,
): void {
  const cell = sheet.getCell(row, column);
  if (cell.isMerged && cell.master) {
    cell.master.value = value;
    return;
  }
  cell.value = value;
}

async function queryCnpjsParallel(
  cnpjs: string[],
  client: SimplesApiClient,
  workers: number,
  roundProgress?: (cnpj: string, done: number, totalTasks: number) => void,
): Promise<Map<string, QueryOutcome>> {
  const totalTasks = cnpjs.length;
  const results = new Map<string, QueryOutcome>();

  let completed = 0;
  let activeRequests = 0;
  let taskIndex = 0;
  const step = Math.max(1, Math.min(ROUND_PROGRESS_STEP, totalTasks || 1));

  const heartbeat = setInterval(() => {
    if (stopRequested || completed >= totalTasks) {
      return;
    }
    const pending = Math.max(totalTasks - completed, 0);
    log(
      `[RODADA_STATUS] concluidos=${completed}/${totalTasks} | em_andamento=${activeRequests} | pendentes=${pending}`,
    );
  }, ROUND_HEARTBEAT_SECONDS * 1000);

  const getNextTask = (): string | null => {
    if (taskIndex >= cnpjs.length) {
      return null;
    }
    const cnpj = cnpjs[taskIndex];
    taskIndex += 1;
    return cnpj;
  };

  const workerLoop = async (workerId: number): Promise<void> => {
    while (true) {
      if (stopRequested) {
        return;
      }
      const cnpj = getNextTask();
      if (!cnpj) {
        return;
      }

      activeRequests += 1;
      try {
        const outcome = await client.consultarSimples(cnpj);
        results.set(cnpj, outcome);
      } catch (error) {
        if (error instanceof StopRequestedError) {
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        results.set(cnpj, {
          status: 'ERRO',
          detail: `worker-${workerId}: excecao ${detail}`,
          provider: 'worker',
        });
      } finally {
        activeRequests = Math.max(activeRequests - 1, 0);
        completed += 1;
        if (roundProgress) {
          try {
            roundProgress(cnpj, completed, totalTasks);
          } catch {
            // no-op
          }
        }
        if (completed % step === 0 || completed === totalTasks) {
          log(
            `[RODADA_ANDAMENTO] ${completed}/${totalTasks} CNPJs consultados | em andamento=${activeRequests}`,
          );
        }
      }
    }
  };

  const numWorkers = Math.max(1, Math.min(workers, cnpjs.length || 1));
  await Promise.all(
    Array.from({ length: numWorkers }, (_, index) => workerLoop(index + 1)),
  );
  clearInterval(heartbeat);
  return results;
}

interface ProcessingOptions {
  inputFile: string;
  outputFile: string;
  delaySeconds: number;
  maxRows: number | null;
  workers: number;
  reprocessRounds: number;
}
async function processWorkbook(
  options: ProcessingOptions,
): Promise<ProcessResult> {
  const {
    inputFile,
    outputFile,
    delaySeconds,
    maxRows,
    workers,
    reprocessRounds,
  } = options;
  const maxRounds = 1 + Math.max(0, reprocessRounds);
  const baseDelaySeconds = Math.max(delaySeconds, MIN_DELAY_SECONDS);

  log(`Abrindo planilha: ${inputFile}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputFile);
  const { sheet, cnpjCol, resultCol } = findTargetSheet(workbook);

  log(`Aba selecionada: ${sheet.name}`);
  log(`Workers em paralelo: ${workers}`);
  log(
    `Rodadas de reprocessamento: ${maxRounds} (1 inicial + ${reprocessRounds} retries)`,
  );
  log(`Delay base por provedor: ${baseDelaySeconds.toFixed(2)}s`);
  log(`Fallback de provedores: ${PROVIDERS_FALLBACK.join(' -> ')}`);

  const rowData: Array<{ row: number; cnpjRaw: string }> = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const raw = toCellString(sheet.getCell(row, cnpjCol).value).trim();
    if (!raw) {
      continue;
    }
    rowData.push({ row, cnpjRaw: raw });
  }

  const selectedRows =
    maxRows !== null ? rowData.slice(0, Math.max(maxRows, 0)) : rowData;
  const total = selectedRows.length;
  reportProgress(0, total);

  let visualProgress = 0;
  let reportedProgress = 0;
  const reportVisualProgress = (value: number): void => {
    const done = Math.max(0, Math.min(total, Math.floor(value)));
    if (done <= reportedProgress) {
      return;
    }
    reportedProgress = done;
    reportProgress(done, total);
  };

  const cachePath = path.join(path.dirname(inputFile), CACHE_FILE);
  const cache = await loadCache(cachePath);
  const cnpjOriginalByRow = new Map<number, string>();
  for (const item of selectedRows) {
    cnpjOriginalByRow.set(item.row, item.cnpjRaw);
  }

  const rowsByCnpj = new Map<string, number[]>();
  const invalidRows: Array<{ row: number; cnpjRaw: string }> = [];
  for (const item of selectedRows) {
    const cnpj = sanitizeCnpj(item.cnpjRaw);
    if (!cnpj) {
      invalidRows.push(item);
      continue;
    }
    const group = rowsByCnpj.get(cnpj) ?? [];
    group.push(item.row);
    rowsByCnpj.set(cnpj, group);
  }

  const validUnique = rowsByCnpj.size;
  let uncachedUnique = 0;
  for (const cnpj of rowsByCnpj.keys()) {
    if (!(cnpj in cache)) {
      uncachedUnique += 1;
    }
  }

  log(`Linhas selecionadas para processamento: ${total}`);
  log(
    `CNPJs validos unicos: ${validUnique} | novos para API: ${uncachedUnique} | invalidos: ${invalidRows.length}`,
  );
  const estimatedSeconds =
    (uncachedUnique * baseDelaySeconds) /
    Math.max(1, Math.min(workers, PROVIDERS_FALLBACK.length));
  log(`Tempo inicial estimado (aprox): ${formatDuration(estimatedSeconds)}`);

  const detailedRows: ReportEntry[] = [];
  const outcomeByCnpj = new Map<string, QueryOutcome>();

  const addReportRow = (
    row: number,
    cnpjRaw: string,
    cnpjClean: string,
    status: string,
    origin: string,
    provider: string,
    detail: string,
  ): void => {
    detailedRows.push({
      linha: String(row),
      cnpj_original: cnpjRaw,
      cnpj_limpo: cnpjClean,
      resultado: status,
      origem: origin,
      provedor: provider,
      detalhe: detail,
    });
  };

  let processed = 0;
  let success = 0;
  let semDadoCount = 0;
  let erroCount = 0;
  let invalidCount = 0;
  let cacheHits = 0;
  let interrupted = false;

  const reportProcessedProgress = (): void => {
    if (processed > visualProgress) {
      visualProgress = processed;
    }
    reportVisualProgress(visualProgress);
  };

  for (const item of invalidRows) {
    setSheetValue(sheet, item.row, resultCol, 'CNPJ_INVALIDO');
    processed += 1;
    invalidCount += 1;
    addReportRow(
      item.row,
      item.cnpjRaw,
      '',
      'CNPJ_INVALIDO',
      'VALIDACAO',
      'VALIDACAO',
      'CNPJ invalido',
    );
    log(
      `[FALHA] Linha ${item.row} | CNPJ bruto='${item.cnpjRaw}' | resultado=CNPJ_INVALIDO`,
    );
    reportProcessedProgress();
  }

  let pendingCnpjs = new Set<string>();
  for (const [cnpj, rows] of rowsByCnpj.entries()) {
    const cachedStatus = cache[cnpj];
    if (cachedStatus === 'SIM' || cachedStatus === 'NÃO') {
      for (const row of rows) {
        setSheetValue(sheet, row, resultCol, cachedStatus);
        addReportRow(
          row,
          cnpjOriginalByRow.get(row) ?? '',
          cnpj,
          cachedStatus,
          'CACHE',
          'CACHE',
          'valor em cache',
        );
      }
      processed += rows.length;
      success += rows.length;
      cacheHits += rows.length;
      outcomeByCnpj.set(cnpj, {
        status: cachedStatus,
        detail: 'valor em cache',
        provider: 'CACHE',
      });
      log(
        `[SUCESSO] CNPJ ${cnpj} | resultado=${cachedStatus} | origem=CACHE | linhas=${rows.length}`,
      );
      reportProcessedProgress();
    } else {
      pendingCnpjs.add(cnpj);
    }
  }

  const client = new SimplesApiClient(baseDelaySeconds);
  const attemptsByCnpj = new Map<string, number>();
  for (const cnpj of pendingCnpjs.values()) {
    attemptsByCnpj.set(cnpj, 0);
  }

  for (let roundIndex = 1; roundIndex <= maxRounds; roundIndex += 1) {
    if (pendingCnpjs.size === 0) {
      break;
    }
    if (stopRequested) {
      interrupted = true;
      log(`[PARANDO] Interrupcao solicitada em ${processed}/${total}.`);
      break;
    }

    const roundList = Array.from(pendingCnpjs).sort();
    log(
      `[RODADA] ${roundIndex}/${maxRounds} | consultando ${roundList.length} CNPJs`,
    );

    const roundSeen = new Set<string>();
    const onRoundProgress = (cnpj: string): void => {
      if (roundSeen.has(cnpj)) {
        return;
      }
      roundSeen.add(cnpj);

      const rowWeight = rowsByCnpj.get(cnpj)?.length ?? 0;
      if (rowWeight <= 0) {
        return;
      }

      const attempts = Math.min(maxRounds, (attemptsByCnpj.get(cnpj) ?? 0) + 1);
      attemptsByCnpj.set(cnpj, attempts);
      visualProgress += rowWeight / maxRounds;
      reportVisualProgress(visualProgress);
    };

    const roundResults = await queryCnpjsParallel(
      roundList,
      client,
      workers,
      onRoundProgress,
    );

    const nextPending = new Set<string>();
    let roundSuccess = 0;
    let roundReprocess = 0;
    let roundFinalAlert = 0;

    for (const cnpj of roundList) {
      const outcome = roundResults.get(cnpj);
      if (!outcome) {
        nextPending.add(cnpj);
        roundReprocess += 1;
        continue;
      }

      const rows = rowsByCnpj.get(cnpj) ?? [];
      if (outcome.status === 'SIM' || outcome.status === 'NÃO') {
        for (const row of rows) {
          setSheetValue(sheet, row, resultCol, outcome.status);
          addReportRow(
            row,
            cnpjOriginalByRow.get(row) ?? '',
            cnpj,
            outcome.status,
            'API',
            outcome.provider,
            outcome.detail,
          );
        }
        cache[cnpj] = outcome.status;
        processed += rows.length;
        success += rows.length;
        roundSuccess += 1;
        outcomeByCnpj.set(cnpj, outcome);

        const spentAttempts = attemptsByCnpj.get(cnpj) ?? 0;
        const remainingAttempts = Math.max(0, maxRounds - spentAttempts);
        if (remainingAttempts > 0) {
          visualProgress += rows.length * (remainingAttempts / maxRounds);
          attemptsByCnpj.set(cnpj, maxRounds);
          reportVisualProgress(visualProgress);
        }

        log(
          `[SUCESSO] CNPJ ${cnpj} | resultado=${outcome.status} | origem=${outcome.provider} | linhas=${rows.length} | detalhe=${outcome.detail}`,
        );
        reportProcessedProgress();
        continue;
      }

      if (
        outcome.status === 'ERRO' &&
        roundIndex < maxRounds &&
        !stopRequested
      ) {
        nextPending.add(cnpj);
        roundReprocess += 1;
        log(
          `[REPROCESSAR] CNPJ ${cnpj} | tentativa=${roundIndex}/${maxRounds} | status=${outcome.status} | detalhe=${outcome.detail}`,
        );
        continue;
      }

      const finalStatus: QueryState =
        outcome.status === 'ERRO' ? 'ERRO' : 'NÃO';
      for (const row of rows) {
        setSheetValue(sheet, row, resultCol, finalStatus);
        addReportRow(
          row,
          cnpjOriginalByRow.get(row) ?? '',
          cnpj,
          finalStatus,
          'API',
          outcome.provider,
          outcome.detail,
        );
      }
      processed += rows.length;
      roundFinalAlert += 1;
      outcomeByCnpj.set(cnpj, {
        status: finalStatus,
        detail: outcome.detail,
        provider: outcome.provider,
      });

      const spentAttempts = attemptsByCnpj.get(cnpj) ?? 0;
      const remainingAttempts = Math.max(0, maxRounds - spentAttempts);
      if (remainingAttempts > 0) {
        visualProgress += rows.length * (remainingAttempts / maxRounds);
        attemptsByCnpj.set(cnpj, maxRounds);
        reportVisualProgress(visualProgress);
      }

      if (finalStatus === 'ERRO') {
        erroCount += rows.length;
      } else {
        semDadoCount += rows.length;
      }
      const level = finalStatus === 'ERRO' ? 'FALHA' : 'ALERTA';
      log(
        `[${level}] CNPJ ${cnpj} | resultado=${finalStatus} | origem=${outcome.provider} | linhas=${rows.length} | detalhe=${outcome.detail}`,
      );
      reportProcessedProgress();
    }

    pendingCnpjs = nextPending;

    if (stopRequested) {
      interrupted = true;
      log(
        `[PARANDO] Interrupcao solicitada em ${processed}/${total}. Salvando progresso parcial da rodada atual.`,
      );
      break;
    }

    log(
      `[RODADA_RESUMO] ${roundIndex}/${maxRounds} | sucesso=${roundSuccess} CNPJs | reprocessar=${roundReprocess} CNPJs | finalizados_alerta=${roundFinalAlert} CNPJs`,
    );

    if (pendingCnpjs.size > 0 && roundIndex < maxRounds) {
      const waitSeconds = Math.min(2 * roundIndex, 8);
      log(
        `[REPROCESSAR] Aguardando ${waitSeconds}s antes da proxima rodada (${pendingCnpjs.size} pendentes)`,
      );
      try {
        await sleepInterruptible(waitSeconds);
      } catch (error) {
        if (error instanceof StopRequestedError) {
          interrupted = true;
          break;
        }
        throw error;
      }
    }
  }

  if (!interrupted && pendingCnpjs.size > 0) {
    for (const cnpj of Array.from(pendingCnpjs).sort()) {
      const rows = rowsByCnpj.get(cnpj) ?? [];
      for (const row of rows) {
        setSheetValue(sheet, row, resultCol, 'ERRO');
        addReportRow(
          row,
          cnpjOriginalByRow.get(row) ?? '',
          cnpj,
          'ERRO',
          'REPROCESSAMENTO_FINAL',
          'fallback',
          'sem retorno apos reprocessamento',
        );
      }
      processed += rows.length;
      erroCount += rows.length;
      outcomeByCnpj.set(cnpj, {
        status: 'ERRO',
        detail: 'sem retorno apos reprocessamento',
        provider: 'fallback',
      });
      log(
        `[FALHA] CNPJ ${cnpj} | resultado=ERRO | detalhe=sem retorno apos reprocessamento`,
      );
      reportProcessedProgress();
    }
  }

  if (interrupted && pendingCnpjs.size > 0) {
    for (const cnpj of Array.from(pendingCnpjs).sort()) {
      for (const row of rowsByCnpj.get(cnpj) ?? []) {
        addReportRow(
          row,
          cnpjOriginalByRow.get(row) ?? '',
          cnpj,
          'PENDENTE',
          'INTERRUPCAO',
          'NÃO_CONCLUIDO',
          'processamento interrompido antes da conclusao',
        );
      }
    }
  }

  log(`Salvando arquivo de saida: ${outputFile}`);
  await workbook.xlsx.writeFile(outputFile);
  await saveCache(cachePath, cache);

  const reportPath = buildReportPath(outputFile);
  await writeDetailedReport(reportPath, detailedRows);

  const failed = invalidCount + erroCount + semDadoCount;
  log(
    `[RESUMO] linhas=${processed}/${total} | sucesso=${success} | sem_dado=${semDadoCount} | erro=${erroCount} | invalidos=${invalidCount} | cache=${cacheHits}`,
  );
  log(`[RESUMO] CNPJs unicos resolvidos=${outcomeByCnpj.size}/${validUnique}`);
  log(`[RESUMO] Relatorio detalhado: ${reportPath}`);

  if (interrupted) {
    log(
      `Processamento interrompido. Linhas processadas: ${processed}/${total}.`,
    );
  } else {
    reportVisualProgress(total);
    log(`Concluido. Linhas processadas: ${processed}/${total}.`);
  }

  return {
    outputFile,
    processed,
    total,
    success,
    failed,
    semDado: semDadoCount,
    erro: erroCount,
    invalid: invalidCount,
    interrupted,
    reportFile: reportPath,
  };
}

async function validateAndBuildOptions(
  raw: unknown,
): Promise<ProcessingOptions> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Payload de processamento invalido.');
  }

  const data = raw as Partial<JobStartRequest>;
  if (
    typeof data.inputFile !== 'string' ||
    data.inputFile.trim().length === 0
  ) {
    throw new Error('Arquivo de entrada invalido.');
  }

  const inputFile = data.inputFile.trim();
  if (path.extname(inputFile).toLowerCase() !== '.xlsx') {
    throw new Error('Selecione um arquivo .xlsx valido.');
  }

  try {
    const stat = await fs.stat(inputFile);
    if (!stat.isFile()) {
      throw new Error('Arquivo de entrada NÃO encontrado.');
    }
  } catch {
    throw new Error('Arquivo de entrada NÃO encontrado.');
  }

  const delaySeconds = Number(data.delaySeconds);
  const workers = Number(data.workers);
  const reprocessRounds = Number(data.reprocessRounds);
  const maxRows =
    data.maxRows === null || data.maxRows === undefined
      ? null
      : Number(data.maxRows);

  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    throw new Error('Delay invalido. Use numero, ex: 0.5');
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
  if (maxRows !== null && (!Number.isInteger(maxRows) || maxRows < 0)) {
    throw new Error('Limite de linhas invalido. Use numero inteiro.');
  }

  return {
    inputFile,
    outputFile: buildOutputPath(inputFile),
    delaySeconds: Math.max(delaySeconds, MIN_DELAY_SECONDS),
    maxRows,
    workers,
    reprocessRounds,
  };
}

async function runWorker(): Promise<void> {
  try {
    const options = await validateAndBuildOptions(workerData);
    const result = await processWorkbook(options);
    postEvent({ type: 'done', result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postEvent({ type: 'error', message });
  }
}

void runWorker();
