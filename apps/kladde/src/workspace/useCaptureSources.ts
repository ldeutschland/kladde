import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Notebook } from "../notebook/notebook";
import { command } from "../platform/native";
import type { Modal } from "./types";

export function useQuickCapture(open: () => void) {
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const attached = listen("quick-capture", () => {
      if (live) open();
    });

    return () => {
      live = false;
      void attached.then((stop) => stop());
    };
  }, []);
}

export function useSharedItems(book: Notebook, mobile: boolean, modal: Modal) {
  const [shared, setShared] = useState<string[]>([]);

  useEffect(() => {
    if (!mobile || !isTauri()) return;
    let live = true;
    const refresh = () => {
      if (!document.hidden)
        void command<string[]>("shared_items")
          .then((items) => {
            if (live) setShared(items);
          })
          .catch(() => {});
    };

    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);

    return () => {
      live = false;
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [book, mobile, modal]);

  return shared;
}
