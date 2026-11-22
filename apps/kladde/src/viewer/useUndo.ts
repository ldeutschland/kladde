import { useCallback, useState } from "react";

const HISTORY_LIMIT = 100;

interface Stack<S> {
  past: S[];
  present: S;
  future: S[];
}

function committed<S>(previous: Stack<S>, update: (current: S) => S) {
  return {
    past: [...previous.past, previous.present].slice(-HISTORY_LIMIT),
    present: update(previous.present),
    future: [],
  };
}

function undone<S>(previous: Stack<S>) {
  if (!previous.past.length) return previous;

  return {
    past: previous.past.slice(0, -1),
    present: previous.past[previous.past.length - 1],
    future: [previous.present, ...previous.future],
  };
}

function redone<S>(previous: Stack<S>) {
  if (!previous.future.length) return previous;

  return {
    past: [...previous.past, previous.present],
    present: previous.future[0],
    future: previous.future.slice(1),
  };
}

export function useUndo<S>(initial: S) {
  const [stack, setStack] = useState<Stack<S>>({
    past: [],
    present: initial,
    future: [],
  });
  const commit = useCallback(
    (update: (current: S) => S) =>
      setStack((previous) => committed(previous, update)),
    [],
  );
  const undo = useCallback(() => setStack(undone), []);
  const redo = useCallback(() => setStack(redone), []);
  const reset = useCallback(
    (value: S) => setStack({ past: [], present: value, future: [] }),
    [],
  );

  return {
    state: stack.present,
    changed: stack.past.length > 0,
    canRedo: stack.future.length > 0,
    commit,
    undo,
    redo,
    reset,
  };
}
