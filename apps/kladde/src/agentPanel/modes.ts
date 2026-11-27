import type { T } from "../locale/locale";
import { onDevice, type Policy } from "../ai/assistant";

export const AGENT_MODES = ["read", "propose", "auto"] as const;
const DEVICE_MODES = ["read", "propose"] as const;

export function effectiveMode(mode: string, policy: Policy) {
  return onDevice(policy) && mode === "auto" ? "propose" : mode;
}

export function modeChoices(t: T, policy?: Policy) {
  const modes = policy && onDevice(policy) ? DEVICE_MODES : AGENT_MODES;

  return modes.map((m) => ({ value: m, label: t(m) }));
}
