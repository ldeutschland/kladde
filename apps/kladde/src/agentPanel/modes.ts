import type { T } from "../locale/locale";

export const AGENT_MODES = ["read", "propose", "auto"] as const;

export function modeChoices(t: T) {
  return AGENT_MODES.map((m) => ({ value: m, label: t(m) }));
}
