import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initI18n } from "./i18n";
import "./index.css";

initI18n();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
