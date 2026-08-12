import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installBrowserDemoBridge } from "./demo-bridge";
import "./styles.css";

if (import.meta.env.DEV && !window.paperOcean) installBrowserDemoBridge();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
