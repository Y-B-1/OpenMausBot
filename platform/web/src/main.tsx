import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import App from "./app.tsx";
import { StoreProvider } from "./store.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
