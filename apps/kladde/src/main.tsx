import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/index.css";
import "./styles/phone/index.css";
import { restoreTheme } from "./platform/startTheme";

restoreTheme();

if (import.meta.env.VITE_KLADDE_NATIVE_QA === "1") {
  void import("../qa/scenario").then(({ run }) =>
    run(() => createRoot(document.getElementById("root")!).render(<App />)),
  );
} else {
  createRoot(document.getElementById("root")!).render(<App />);
}
