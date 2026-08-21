import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initSettings } from "./settings";
import { syncThemeFromSettings } from "./theme";
import "./index.css";

// Settings load before first render so every page reads them synchronously.
void initSettings().then(() => {
  syncThemeFromSettings();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
