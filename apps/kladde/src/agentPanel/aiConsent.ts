import {
  onDevice,
  providerOf,
  type Policy,
  type Provider,
} from "../ai/assistant";
import { localOffered, type LocalStatus } from "../ai/localModel";
import type { Ask } from "../ui/dialog";
import type { T } from "../locale/locale";

function preferredProvider(
  policy: Policy,
  local: LocalStatus | null,
): Provider {
  const fresh = onDevice(policy) || !policy.model;

  return localOffered(local) && fresh ? "local" : providerOf(policy);
}

export async function enabledPolicy(
  policy: Policy,
  local: LocalStatus | null,
  ask: Ask,
  t: T,
): Promise<Policy | null> {
  const provider = preferredProvider(policy, local);
  const agreed = await ask(t("aiPrivacy"), undefined, {
    detail: t(
      provider === "local" ? "aiLocalPrivacyDetail" : "aiPrivacyDetail",
    ),
    action: t("aiEnable"),
  });

  if (!agreed) return null;

  const web_search = provider === "local" ? false : policy.web_search;

  return { ...policy, enabled: true, provider, web_search };
}

export function cloudAllowed(ask: Ask, t: T) {
  return ask(t("aiCloudSwitch"), undefined, {
    detail: t("aiPrivacyDetail"),
    action: t("allow"),
  });
}
