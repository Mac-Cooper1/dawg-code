/**
 * The renderer's entry point: one store per window, created from the bridge, then the app.
 */
import "./styles/tokens.css";
import "./styles/base.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { PlatformProvider } from "./app/platform.tsx";
import { getBridge } from "./bridge/index.ts";
import { AppStoreProvider, createAppStore } from "./state/store.ts";

const bridge = getBridge();
const store = createAppStore({ bridge });

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PlatformProvider os={bridge.platform.os}>
        <AppStoreProvider store={store}>
          <App />
        </AppStoreProvider>
      </PlatformProvider>
    </StrictMode>,
  );
}

// Once per window, outside React: StrictMode runs effects twice in development.
async function start(): Promise<void> {
  await store.getState().actions.start();
}
start().catch((error: unknown) => {
  console.error("dawg-code: could not start", error);
});
