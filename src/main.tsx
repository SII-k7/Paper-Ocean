import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installBrowserBridge } from "./browser-bridge";
import { installBrowserDemoBridge } from "./demo-bridge";
import "./styles.css";

if (!window.paperOcean) {
  if (import.meta.env.VITE_PAPER_OCEAN_MODE === "demo") installBrowserDemoBridge();
  else if (import.meta.env.VITE_PAPER_OCEAN_MODE === "web" || import.meta.env.DEV) installBrowserBridge();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
