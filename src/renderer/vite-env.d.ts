/// <reference types="vite/client" />

import type { BridgeApi } from "@shared/contracts";

declare global {
  interface Window {
    consultaSimples: BridgeApi;
  }
}
