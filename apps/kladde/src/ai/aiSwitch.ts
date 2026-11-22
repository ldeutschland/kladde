import { createContext, useContext } from "react";

export const AiSwitch = createContext(false);

export function useAiOn() {
  return useContext(AiSwitch);
}
