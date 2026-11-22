import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface Stage {
  ref: RefObject<HTMLDivElement | null>;
  element: HTMLDivElement | null;
  attach: (node: HTMLDivElement | null) => void;
}

export function useStage(): Stage {
  const ref = useRef<HTMLDivElement | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    setElement(node);
  }, []);

  return { ref, element, attach };
}

export function useStageSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    if (!element) return;
    const measure = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });

    measure();
    const observer = new ResizeObserver(measure);

    observer.observe(element);

    return () => observer.disconnect();
  }, [element]);

  return size;
}
