import { lazy } from "react";

export const loadCapture = () => import("../capture/Capture");

export const Templates = lazy(() =>
  import("./Templates").then((m) => ({ default: m.Templates })),
);
export const Capture = lazy(() =>
  loadCapture().then((m) => ({ default: m.Capture })),
);
export const DestinationSettings = lazy(() =>
  import("../capture/DestinationSettings").then((m) => ({
    default: m.DestinationSettings,
  })),
);
export const Recorder = lazy(() =>
  import("../capture/Recorder").then((m) => ({ default: m.Recorder })),
);
export const HistoryPanel = lazy(() =>
  import("../versions/History").then((m) => ({ default: m.HistoryPanel })),
);
export const Editor = lazy(() =>
  import("../editor/Editor").then((m) => ({ default: m.Editor })),
);
export const Database = lazy(() =>
  import("../databaseView/Database").then((m) => ({ default: m.Database })),
);
export const Properties = lazy(() =>
  import("../databaseView/Properties").then((m) => ({
    default: m.Properties,
  })),
);
export const EmojiPicker = lazy(() =>
  import("../ui/EmojiPicker").then((m) => ({ default: m.EmojiPicker })),
);
export const AgentPanel = lazy(() =>
  import("../agentPanel/AgentPanel").then((m) => ({ default: m.AgentPanel })),
);
export const WebClipper = lazy(() => import("../capture/WebClipper"));
export const PrivacyPolicy = lazy(() =>
  import("./PrivacyPolicy").then((m) => ({ default: m.PrivacyPolicy })),
);
export const Licenses = lazy(() =>
  import("./Licenses").then((m) => ({ default: m.Licenses })),
);
export const Transfer = lazy(() =>
  import("../files/Transfer").then((m) => ({ default: m.Transfer })),
);
