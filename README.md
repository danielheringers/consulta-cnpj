# Consulta Simples Nacional (Electron + TypeScript)

Migracao do `consulta_simples_nacional.py` para Electron, mantendo:

- leitura de `.xlsx` com coluna `Criterio de pesquisa 1`
- preenchimento de `SIMPLES NACIONAL` com `SIM`, `NAO`, `SEM_DADO`, `ERRO`, `CNPJ_INVALIDO`
- cache local (`cache_simples_nacional.json`)
- fallback de provedores (`ReceitaWS -> MinhaReceita -> BrasilAPI -> CNPJ.ws`)
- reprocessamento de falhas por rodadas
- relatorio detalhado CSV (`*_log_detalhado.csv`)
- parada segura com salvamento parcial

## Arquitetura

- `src/main/main.ts`: processo principal Electron, janela unica, IPC contratual e seguro
- `src/main/preload.ts`: API minima via `contextBridge`
- `src/main/workers/processor.worker.ts`: processamento pesado (IO/rede) em `worker_threads`
- `src/renderer/*`: UI (sem logica de negocio critica)
- `src/shared/contracts.ts`: contratos de IPC/eventos

## Seguranca aplicada

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- `preload` com superficie pequena
- bloqueio de `window.open`
- CSP configurada

## Requisitos

- Node.js 20+
- npm 10+

## Como rodar em desenvolvimento

```powershell
npm install
npm run dev
```

## Como gerar build local e executar

```powershell
npm run build
electron .
```

Ou em um comando:

```powershell
npm start
```

## Empacotamento Windows (NSIS)

```powershell
npm run dist
```

Saida em `release/`.

## Fluxo da UI

1. Selecione a planilha `.xlsx`.
2. Configure `Delay`, `Limite de linhas`, `Workers` e `Reprocessamentos`.
3. Clique em `Processar planilha`.
4. Acompanhe logs em tempo real.
5. Ao final, abra o `.xlsx` de saida e o `.csv` de relatorio pelos botoes da interface.

## Compatibilidade com o script Python

O arquivo Python original foi mantido no repositorio (`consulta_simples_nacional.py`) como referencia historica.
