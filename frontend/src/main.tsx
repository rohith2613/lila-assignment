// ---------------------------------------------------------------------------
// React entry point. Renders <App /> into #root and registers the global
// stylesheet (which pulls in Tailwind via @tailwind directives).
// ---------------------------------------------------------------------------
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  // Should never happen because the root div is in index.html, but a defensive
  // check beats a silent failure if a future change breaks the markup.
  throw new Error("#root element not found in index.html");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
