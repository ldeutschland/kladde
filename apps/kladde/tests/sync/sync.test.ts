import { describe, expect, it } from "vitest";
import {
  SYNC_OFF,
  rescueMark,
  retryDelay,
  settle,
  statusFromError,
  statusFromReport,
  syncDetails,
  type SyncReport,
} from "../../src/sync/sync";
import { translator } from "../../src/locale/locale";

const t = translator("de");
const clean: SyncReport = {
  changed: [],
  removed: [],
  rescue: [],
  failed: [],
  waiting: 0,
  stopped: null,
};

describe("sync status", () => {
  it("marks a clean run as synced at the given time", () => {
    const status = statusFromReport(clean, SYNC_OFF, 1000);

    expect(status.phase).toBe("synced");
    expect(status.at).toBe(1000);
    expect(status.problem).toBeNull();
  });

  it("keeps the last success time when the server is unreachable", () => {
    const synced = statusFromReport(clean, SYNC_OFF, 1000);
    const offline = statusFromReport(
      { ...clean, stopped: "offline", waiting: 3 },
      synced,
      2000,
    );

    expect(offline.phase).toBe("offline");
    expect(offline.at).toBe(1000);
    expect(offline.waiting).toBe(3);
  });

  it("reports failed pages without hiding the successful ones", () => {
    const status = statusFromReport(
      { ...clean, changed: ["a"], failed: ["b"] },
      SYNC_OFF,
      5,
    );

    expect(status.phase).toBe("error");
    expect(status.at).toBe(5);
    const lines = syncDetails(status, t, (id) => "Seite " + id);

    expect(lines.some((line) => line.includes("Seite b"))).toBe(true);
  });

  it("treats attachment upload problems as a synced run with a hint", () => {
    const status = statusFromReport(
      { ...clean, stopped: "files" },
      SYNC_OFF,
      9,
    );

    expect(status.phase).toBe("error");
    expect(status.at).toBe(9);
    expect(status.problem).toBe("files");
  });

  it("maps core error codes and keeps unknown text visible", () => {
    expect(statusFromError("sync:auth", SYNC_OFF).phase).toBe("auth");
    expect(statusFromError(Error("sync:offline"), SYNC_OFF).phase).toBe(
      "offline",
    );
    expect(statusFromError("Notebook locked", SYNC_OFF).problem).toBe(
      "storage",
    );
    const unknown = statusFromError("Workspace not connected", SYNC_OFF);

    expect(unknown.problem).toBe("unknown");
    expect(unknown.detail).toBe("Workspace not connected");
  });

  it("explains every problem in words", () => {
    for (const code of [
      "offline",
      "auth",
      "denied",
      "integrity",
      "storage",
      "outdated_app",
      "outdated_server",
    ]) {
      const lines = syncDetails(
        statusFromError("sync:" + code, SYNC_OFF),
        t,
        String,
      );

      expect(lines[0]).not.toMatch(/sync:|undefined/);
    }
  });
});

describe("full account", () => {
  it("shows a full account at once and explains it", () => {
    const report = { ...clean, failed: ["a"], waiting: 1, stopped: "full" };
    const status = statusFromReport(report, SYNC_OFF, 1000);

    expect(status.phase).toBe("error");
    expect(status.problem).toBe("full");
    expect(status.at).toBeNull();
    expect(settle(status, SYNC_OFF, 1).phase).toBe("error");
    const [reason] = syncDetails(status, t, String);

    expect(reason).toContain("voll");
  });

  it("does not report write contention as a problem", () => {
    const report = { ...clean, retry: ["a"], waiting: 1 };
    const status = statusFromReport(report, SYNC_OFF, 1000);

    expect(status.phase).toBe("synced");
    expect(status.problem).toBeNull();
  });
});

describe("version mismatch", () => {
  it("asks for an app update when the server needs a newer app", () => {
    const status = statusFromError("sync:outdated_app", SYNC_OFF);

    expect(status.phase).toBe("outdated");
    expect(status.problem).toBe("outdated_app");
    expect(settle(status, SYNC_OFF, 1).phase).toBe("outdated");
    const [reason] = syncDetails(status, t, String);

    expect(reason).toContain("App");
    expect(reason).toContain("bleiben");
  });

  it("names the server when it is too old", () => {
    const report = { ...clean, waiting: 2, stopped: "outdated_server" };
    const status = statusFromReport(report, SYNC_OFF, 1000);

    expect(status.phase).toBe("outdated");
    expect(status.waiting).toBe(2);
    const [reason] = syncDetails(status, t, String);

    expect(reason).toContain("Sync-Server ist zu alt");
  });

  it("keeps syncing but explains pages from a newer app", () => {
    const report = { ...clean, failed: ["a"], newer: ["a"], waiting: 1 };
    const status = statusFromReport(report, SYNC_OFF, 1000);

    expect(status.phase).toBe("error");
    expect(status.problem).toBeNull();
    expect(status.newer).toEqual(["a"]);
    const lines = syncDetails(status, t, String);

    expect(lines.some((line) => line.includes("neueren Kladde-Version"))).toBe(
      true,
    );
  });

  it("shows lagging servers and devices as hints on a clean run", () => {
    const report = { ...clean, behind: ["server", "device", "someday"] };
    const status = statusFromReport(report, SYNC_OFF, 1000);

    expect(status.phase).toBe("synced");
    expect(status.behind).toEqual(["server", "device"]);
    expect(syncDetails(status, t, String)).toHaveLength(3);
  });

  it("keeps hints through quick runs and failures until a full run clears them", () => {
    const full = { ...clean, behind: ["server"], failed: ["a"], newer: ["a"] };
    const first = statusFromReport(full, SYNC_OFF, 1000);
    const quick = statusFromReport({ ...clean, failed: ["a"] }, first, 2000);

    expect(quick.behind).toEqual(["server"]);
    expect(quick.newer).toEqual(["a"]);
    const offline = statusFromError("sync:offline", quick);

    expect(offline.behind).toEqual(["server"]);
    const updated = statusFromReport({ ...clean, behind: [] }, offline, 3000);

    expect(updated.behind).toEqual([]);
    expect(updated.newer).toEqual([]);
  });
});

describe("sync resilience", () => {
  const synced = statusFromReport(clean, SYNC_OFF, 1000);

  it("hides a single transient failure but shows a repeated one", () => {
    const offline = statusFromError("sync:offline", synced);

    expect(settle(offline, synced, 1)).toEqual(synced);
    expect(settle(offline, synced, 2).phase).toBe("offline");
    const busy = statusFromError("sync:busy", synced);

    expect(settle(busy, synced, 1)).toEqual(synced);
    expect(settle(busy, synced, 2).phase).toBe("offline");
  });

  it("keeps the count of waiting changes while hiding a hiccup", () => {
    const offline = statusFromReport(
      { ...clean, stopped: "offline", waiting: 4 },
      synced,
      2000,
    );

    expect(settle(offline, synced, 1).waiting).toBe(4);
  });

  it("shows lasting problems at once", () => {
    const auth = statusFromError("sync:auth", synced);

    expect(settle(auth, synced, 1).phase).toBe("auth");
    const integrity = statusFromError("sync:integrity", synced);

    expect(settle(integrity, synced, 1).phase).toBe("error");
  });

  it("backs off with growing delays and waits longer when busy", () => {
    const none = () => 0;

    expect(retryDelay(1, "offline", none)).toBe(2000);
    expect(retryDelay(2, "offline", none)).toBe(5000);
    expect(retryDelay(99, "offline", none)).toBe(60000);
    expect(retryDelay(1, "busy", none)).toBe(30000);
    expect(retryDelay(1, "offline", () => 1)).toBe(2500);
  });

  it("explains a busy server in words", () => {
    const lines = syncDetails(
      statusFromError("sync:busy", SYNC_OFF),
      t,
      String,
    );

    expect(lines[0]).not.toMatch(/sync:|undefined/);
  });

  it("marks rescued copies per device", () => {
    expect(rescueMark("mac", "page")).not.toBe(rescueMark("phone", "page"));
  });
});
