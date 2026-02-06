# AGENTS.md

**Electron App — Lean por padrão, Enterprise por design**

## Princípios

1. **Lean first**: baixo consumo de memória, startup rápido, poucas dependências.
2. **Enterprise-ready**: segurança, auditabilidade, atualização controlada e observabilidade desde o início.
3. **Renderer mínimo**: UI pura. Nada de lógica pesada, segredos ou IO crítico.
4. **Main previsível**: processos claros, IPC contratual, fácil de observar e depurar.
5. **Escala sem refactor traumático**: o que entra para “enterprise” já nasce compatível.

---

## 1. Stack Base

### Base técnica

- Electron (versão estável recente, version pin)
- TypeScript (obrigatório, `strict`)
- Monorepo (quando fizer sentido):
  - `pnpm` workspaces
  - Nx/Turborepo apenas se houver ganho real

### UI

- React
  - Dependências mínimas
  - Avaliar Svelte/Lit se o app for essencialmente UI-driven

### Build

- Vite (preferencial)
  - Webpack apenas se exigido por padrão corporativo

- ESLint + Prettier
- Lockfile obrigatório
- SBOM gerado no pipeline

---

## 2. Estado e Persistência

### Estado

- Local e mínimo
- Evitar Redux/MobX se não for indispensável
- Preferir estado derivado + hooks simples

### Persistência local

- SQLite
  - Driver síncrono e rápido (ex.: `better-sqlite3`)

- Alternativa:
  - Arquivo local simples quando possível

> Mesmo em cenário enterprise, persistência local deve ser **previsível, versionada e migrável**.

---

## 3. Arquitetura Electron (performance + governança)

### Janelas

- **Uma `BrowserWindow` como padrão**
- Navegação interna via routing
- Criar novas janelas apenas quando:
  - Isolamento visual/funcional for indispensável

### Separação de responsabilidades

- Renderer:
  - UI e interação
  - Nenhum segredo
  - Nenhuma lógica pesada

- Main / Workers:
  - CPU heavy → `worker_threads`
  - IO pesado → main ou processo dedicado

### IPC

- IPC contratual
- Payloads pequenos:
  - IDs
  - Paginação
  - Streams

- Nunca trafegar objetos grandes ou estado global

---

## 4. BrowserWindow — Segurança obrigatória (lean + enterprise)

### `webPreferences` (baseline imutável)

- `contextIsolation: true`
- `sandbox: true` (sempre que possível)
- `nodeIntegration: false`
- `enableRemoteModule: false`
- `preload`:
  - APIs mínimas
  - Sempre via `contextBridge`
  - Superfície pequena e documentada

> Essas regras reduzem ataque, acoplamento e desperdício de memória.

---

## 5. UI e DOM (impacto direto em RAM)

- Evitar bibliotecas “all-in-one”
  - UI kits gigantes
  - Rich text editors pesados
  - Grids enterprise sem necessidade real

- Listas grandes:
  - Sempre virtualização
  - Renderizar apenas o visível

- Assets:
  - Imagens comprimidas
  - Lazy-loading
  - Nenhum asset “raw” em produção

---

## 6. Runtime e consumo em idle

- Evitar timers/intervals agressivos
- Reduzir re-renderizações (especialmente com React)
- Background tasks:
  - Debounce / throttle
  - Agendamento explícito

### Produção

- DevTools desativado
- Source maps:
  - Fora do bundle ou condicionais

---

## 7. Empacotamento (tamanho, RAM e previsibilidade)

- `asar: true`
- `files` e `extraResources` estritamente controlados
- Não empacotar dev dependencies
- `npmRebuild: false` quando aplicável
- Auditoria contínua de dependências grandes ou duplicadas

---

## 8. Segurança ampliada (quando entra em enterprise)

- CSP rigorosa
  - Bloqueio explícito de `eval`

- Gestão de segredos:
  - Nunca no renderer
  - Usar keychain do SO:
    - Windows Credential Manager
    - macOS Keychain
    - Linux libsecret

### Assinatura de código

- Windows: Authenticode
- macOS:
  - Notarization
  - Hardened runtime

### Pipeline

- Dependabot / Snyk
- SAST / DAST no CI

---

## 9. Identidade e acesso

- Autenticação via IdP corporativo

- Autorização:
  - RBAC ou ABAC
  - Baseada em claims/roles

- Políticas:
  - Sessão
  - Refresh token
  - Device binding (quando aplicável)

- Integração com MDM (quando exigido):
  - Intune
  - Jamf

---

## 10. Updates e distribuição

- Auto-update controlado:
  - `electron-updater` + `electron-builder`
  - Feed privado

- Canais:
  - stable
  - pilot
  - beta

- Rollout gradual

- Kill-switch remoto

- Suporte a:
  - Proxy corporativo
  - Ambientes offline

---

## 11. Observabilidade e suporte

- Logs estruturados:
  - Main + Renderer
  - Correlação por request/ação

- Crash reporting:
  - Sentry ou equivalente corporativo

- Métricas:
  - Tempo de boot
  - Uso de memória
  - Freezes
  - Latência de IPC

- Feature flags:
  - LaunchDarkly ou solução interna

---

## 12. Qualidade e governança

- Testes:
  - Unitários: Vitest ou Jest
  - E2E: Playwright (compatível com Electron)

- CI/CD:
  - Build reproduzível
  - Assinatura
  - Notarization
  - SBOM
  - Scans de segurança

- Dependências:
  - Whitelist de libs
  - Revisão de licenças (MIT / Apache vs GPL)

- Documentação:
  - ADRs para decisões estruturais

---

## 13. Checklist prático (alto impacto)

1. Manter o renderer mínimo e previsível.
2. Usar apenas 1 `BrowserWindow`.
3. Virtualizar listas e evitar DOM grande.
4. Mover tarefas pesadas para `worker_threads`.
5. IPC com payload pequeno (IDs, paginação).
6. Build com Vite + tree-shaking + code splitting.
7. Empacotamento restrito e auditoria constante de dependências.

---

## 14. Diretrizes Frontend (estilo GPT)

- O frontend deve ser chat-first e visualmente próximo ao padrão GPT:
  - sidebar de sessões estável
  - área principal com header, histórico e composer

- Evitar alongamento desnecessário dos componentes:
  - não forçar `height: 100%` em cards/itens de conteúdo
  - priorizar `auto`/`fit-content` em blocos que crescem por conteúdo

- O crescimento das mensagens não pode empurrar outros blocos do layout:
  - apenas o painel de mensagens deve rolar
  - composer deve permanecer estável no rodapé da área de chat

- Recursos avançados (RAG, Vector Store, MCP e afins):
  - opcionais por padrão
  - exibidos apenas em configurações, não no fluxo principal de conversa
