import { useEffect, useMemo, useRef, useState } from "react";
import type { ProcessResult, WorkerEvent } from "@shared/contracts";

type SessionStatus = "running" | "done" | "interrupted" | "error";

interface SessionLog {
  timestamp: string;
  message: string;
}

interface SessionRecord {
  id: string;
  startedAt: number;
  status: SessionStatus;
  progressDone: number;
  progressTotal: number;
  logs: SessionLog[];
  result: ProcessResult | null;
  errorMessage: string | null;
}

function nowClock(): string {
  return new Date().toLocaleTimeString("pt-BR", { hour12: false });
}

function appendLog(logs: SessionLog[], message: string): SessionLog[] {
  const next = [...logs, { timestamp: nowClock(), message }];
  if (next.length > 2000) {
    return next.slice(next.length - 2000);
  }
  return next;
}

function formatPathName(fullPath: string): string {
  const parts = fullPath.split(/[/\\]/g);
  return parts[parts.length - 1] ?? fullPath;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "calculando...";
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function App(): JSX.Element {
  const [filePath, setFilePath] = useState("");
  const [delaySeconds, setDelaySeconds] = useState("0.5");
  const [maxRows, setMaxRows] = useState("");
  const [workers, setWorkers] = useState("6");
  const [reprocessRounds, setReprocessRounds] = useState("2");
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [statusLabel, setStatusLabel] = useState("Aguardando arquivo...");

  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const runningSessionRef = useRef<string | null>(null);
  const runningStartedAtRef = useRef<number | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  useEffect(() => {
    const unsubscribe = window.consultaSimples.onJobEvent((event: WorkerEvent) => {
      const sessionId = runningSessionRef.current;
      if (!sessionId) {
        return;
      }

      setSessions((current) =>
        current.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }
          if (event.type === "log") {
            return { ...session, logs: appendLog(session.logs, event.message) };
          }
          if (event.type === "progress") {
            return { ...session, progressDone: event.done, progressTotal: event.total };
          }
          if (event.type === "done") {
            return {
              ...session,
              status: event.result.interrupted ? "interrupted" : "done",
              result: event.result
            };
          }
          if (event.type === "error") {
            return {
              ...session,
              status: "error",
              errorMessage: event.message,
              logs: appendLog(session.logs, `[ERRO] ${event.message}`)
            };
          }
          return session;
        })
      );

      if (event.type === "progress") {
        if (event.total <= 0) {
          setStatusLabel("Processando: preparando...");
          return;
        }
        if (running) {
          const startedAt = runningStartedAtRef.current;
          if (startedAt !== null && event.done > 0) {
            const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
            const remaining = Math.max((event.total - event.done) * (elapsed / event.done), 0);
            setStatusLabel(`Processando: ${event.done}/${event.total} | restante aprox: ${formatDuration(remaining)}`);
          } else {
            setStatusLabel(`Processando: ${event.done}/${event.total} | restante aprox: calculando...`);
          }
        }
      }

      if (event.type === "done") {
        setRunning(false);
        runningSessionRef.current = null;
        runningStartedAtRef.current = null;
        if (event.result.interrupted) {
          setStatusLabel(`Interrompido: ${event.result.processed}/${event.result.total}`);
        } else {
          setStatusLabel(`Concluido: ${formatPathName(event.result.outputFile)}`);
        }
      }

      if (event.type === "error") {
        setRunning(false);
        runningSessionRef.current = null;
        runningStartedAtRef.current = null;
        setStatusLabel("Erro durante o processamento");
      }
    });

    return unsubscribe;
  }, [running]);

  useEffect(() => {
    if (!logViewportRef.current) {
      return;
    }
    logViewportRef.current.scrollTop = logViewportRef.current.scrollHeight;
  }, [activeSession?.logs]);

  const progressPercent = useMemo(() => {
    if (!activeSession || activeSession.progressTotal <= 0) {
      return 0;
    }
    return Math.min((activeSession.progressDone / activeSession.progressTotal) * 100, 100);
  }, [activeSession]);

  const handleSelectFile = async (): Promise<void> => {
    const selected = await window.consultaSimples.selectXlsxFile();
    if (selected) {
      setFilePath(selected);
      setStatusLabel("Arquivo carregado. Configure e inicie o processamento.");
    }
  };

  const handleStart = async (): Promise<void> => {
    if (!filePath.trim()) {
      setStatusLabel("Selecione um arquivo .xlsx valido.");
      return;
    }

    const parsedDelay = Number(delaySeconds.replace(",", "."));
    const parsedWorkers = Number(workers);
    const parsedRounds = Number(reprocessRounds);
    const parsedMaxRows = maxRows.trim() ? Number(maxRows) : null;

    if (!Number.isFinite(parsedDelay) || parsedDelay <= 0) {
      setStatusLabel("Delay invalido.");
      return;
    }
    if (!Number.isInteger(parsedWorkers) || parsedWorkers <= 0) {
      setStatusLabel("Workers invalidos.");
      return;
    }
    if (!Number.isInteger(parsedRounds) || parsedRounds < 0) {
      setStatusLabel("Rodadas de reprocessamento invalidas.");
      return;
    }
    if (parsedMaxRows !== null && (!Number.isInteger(parsedMaxRows) || parsedMaxRows < 0)) {
      setStatusLabel("Limite de linhas invalido.");
      return;
    }

    try {
      setRunning(true);
      setStatusLabel("Iniciando...");
      const response = await window.consultaSimples.startJob({
        inputFile: filePath,
        delaySeconds: parsedDelay,
        maxRows: parsedMaxRows,
        workers: parsedWorkers,
        reprocessRounds: parsedRounds
      });

      const session: SessionRecord = {
        id: response.jobId,
        startedAt: Date.now(),
        status: "running",
        progressDone: 0,
        progressTotal: 0,
        logs: [{ timestamp: nowClock(), message: "Processamento iniciado." }],
        result: null,
        errorMessage: null
      };

      runningSessionRef.current = response.jobId;
      runningStartedAtRef.current = session.startedAt;
      setSessions((current) => [session, ...current]);
      setActiveSessionId(response.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunning(false);
      runningSessionRef.current = null;
      runningStartedAtRef.current = null;
      setStatusLabel(message);
    }
  };

  const handleStop = async (): Promise<void> => {
    if (!running) {
      return;
    }
    const accepted = await window.consultaSimples.stopJob();
    if (accepted) {
      setStatusLabel("Parando...");
    }
  };

  const handleOpenArtifact = async (kind: "output" | "report"): Promise<void> => {
    if (!activeSession?.result) {
      return;
    }
    const target = kind === "output" ? activeSession.result.outputFile : activeSession.result.reportFile;
    const openError = await window.consultaSimples.openPath(target);
    if (openError) {
      setStatusLabel(`Falha ao abrir arquivo: ${openError}`);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <h1>Consulta CNPJ</h1>
          <p>Painel de execucoes</p>
        </div>
        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="session-empty">Nenhuma execucao iniciada.</div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                className={`session-item${session.id === activeSessionId ? " is-active" : ""}`}
                onClick={() => setActiveSessionId(session.id)}
              >
                <span className={`status-dot status-${session.status}`} />
                <div className="session-text">
                  <strong>{new Date(session.startedAt).toLocaleTimeString("pt-BR", { hour12: false })}</strong>
                  <small>
                    {session.progressTotal > 0 ? `${session.progressDone}/${session.progressTotal}` : "Aguardando dados"}
                  </small>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <main className="main-panel">
        <header className="panel-header">
          <div>
            <h2>Consulta Simples Nacional</h2>
            <p>{statusLabel}</p>
          </div>
          <div className="header-badges">
            <span className={`badge ${running ? "badge-running" : "badge-idle"}`}>{running ? "Em execucao" : "Parado"}</span>
            <span className="badge">{progressPercent.toFixed(0)}%</span>
          </div>
        </header>

        <section className="log-panel" ref={logViewportRef}>
          {(activeSession?.logs ?? []).length === 0 ? (
            <div className="log-empty">Os logs aparecerao aqui durante a execucao.</div>
          ) : (
            (activeSession?.logs ?? []).map((entry, index) => (
              <article key={`${entry.timestamp}-${index}`} className="log-line">
                <time>{entry.timestamp}</time>
                <p>{entry.message}</p>
              </article>
            ))
          )}
        </section>

        <footer className="composer-panel">
          <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
            <span style={{ width: `${progressPercent}%` }} />
          </div>

          <div className="field-grid">
            <label className="field field-file">
              <span>Arquivo XLSX</span>
              <div className="file-row">
                <input value={filePath} readOnly placeholder="Selecione a planilha..." />
                <button type="button" onClick={handleSelectFile}>
                  Selecionar
                </button>
              </div>
            </label>

            <label className="field">
              <span>Delay (s)</span>
              <input value={delaySeconds} onChange={(event) => setDelaySeconds(event.target.value)} disabled={running} />
            </label>

            <label className="field">
              <span>Limite de linhas</span>
              <input value={maxRows} onChange={(event) => setMaxRows(event.target.value)} disabled={running} placeholder="Opcional" />
            </label>

            <label className="field">
              <span>Workers</span>
              <input value={workers} onChange={(event) => setWorkers(event.target.value)} disabled={running} />
            </label>

            <label className="field">
              <span>Reprocessamentos</span>
              <input value={reprocessRounds} onChange={(event) => setReprocessRounds(event.target.value)} disabled={running} />
            </label>
          </div>

          <div className="action-row">
            <button type="button" className="primary" disabled={running} onClick={handleStart}>
              Processar planilha
            </button>
            <button type="button" className="ghost" disabled={!running} onClick={handleStop}>
              Parar
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!activeSession?.result}
              onClick={() => {
                void handleOpenArtifact("output");
              }}
            >
              Abrir XLSX
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!activeSession?.result}
              onClick={() => {
                void handleOpenArtifact("report");
              }}
            >
              Abrir CSV
            </button>
          </div>
        </footer>
      </main>
    </div>
  );
}
