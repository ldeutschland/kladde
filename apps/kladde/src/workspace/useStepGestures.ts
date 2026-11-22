import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { followTrackpadSwipe, type Direction } from "./trackpadSwipe";

export interface Stepper {
  can: (direction: Direction) => boolean;
  go: (direction: Direction) => void;
}

export function useStepGestures(mobile: boolean, stepper: Stepper) {
  const latest = useRef(stepper);

  latest.current = stepper;
  useEffect(() => {
    if (mobile) return;
    let live = true;
    const step = (direction: Direction) => {
      if (live && latest.current.can(direction)) latest.current.go(direction);
    };
    const stopSwipe = followTrackpadSwipe({
      area: () => document.querySelector<HTMLElement>(".desktop .work"),
      can: (direction) => latest.current.can(direction),
      go: step,
    });
    const attached = isTauri()
      ? listen<string>("navigate", ({ payload }) => {
          if (payload === "back") step(-1);
          if (payload === "forward") step(1);
        })
      : null;

    return () => {
      live = false;
      stopSwipe();
      void attached?.then((stop) => stop());
    };
  }, [mobile]);
}
