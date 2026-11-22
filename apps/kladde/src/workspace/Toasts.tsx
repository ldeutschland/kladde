import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Undo2 } from "lucide-react";
import type { T } from "../locale/locale";
import type { Toast } from "./types";

const TOAST_MS = 6000;

export function useToast() {
  const [toast, setToast] = useState<Toast>(null);
  const [held, hold] = useState<Toast>(null);
  const notify = useCallback((text: string) => setToast({ text }), []);

  useEffect(() => {
    if (!toast || toast.busy || held === toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);

    return () => clearTimeout(timer);
  }, [toast, held]);

  return { toast, setToast, notify, hold };
}

type Toasts = ReturnType<typeof useToast>;

export function ToastArea({ toasts, t }: { toasts: Toasts; t: T }) {
  const { toast, setToast, hold } = toasts;

  return (
    <div className="toastarea" aria-live="polite">
      {toast && (
        <div
          className="toast"
          key={toast.text}
          onMouseEnter={() => hold(toast)}
          onMouseLeave={() => hold(null)}
        >
          {toast.busy && <LoaderCircle className="spin" aria-hidden="true" />}
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              <Undo2 />
              {t("undoShort")}
            </button>
          )}
          {toast.open && (
            <button
              onClick={() => {
                toast.open?.();
                setToast(null);
              }}
            >
              {t("open")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
