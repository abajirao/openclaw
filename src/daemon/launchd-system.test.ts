// System launchd ownership tests cover loaded, installed, and unverifiable states.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  launchctl: { stdout: "", stderr: "Could not find service", code: 113 },
  files: new Map<string, string>(),
  accessErrors: new Map<string, string>(),
  readdirError: "",
  plutilLabels: new Map<string, string>(),
  plutilErrors: new Map<string, string>(),
}));

function fsError(code: string, target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${target}`), { code });
}

vi.mock("node:fs/promises", () => {
  const mocked = {
    access: vi.fn(async (target: string) => {
      const code = state.accessErrors.get(target);
      if (code) {
        throw fsError(code, target);
      }
      if (!state.files.has(target)) {
        throw fsError("ENOENT", target);
      }
    }),
    readdir: vi.fn(async (dir: string) => {
      if (state.readdirError) {
        throw fsError(state.readdirError, dir);
      }
      const prefix = `${dir}/`;
      return Array.from(state.files.keys())
        .filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes("/"))
        .map((file) => file.slice(prefix.length));
    }),
    readFile: vi.fn(async (target: string) => {
      const contents = state.files.get(target);
      if (contents === undefined) {
        throw fsError("ENOENT", target);
      }
      return contents;
    }),
  };
  return { ...mocked, default: mocked };
});

const execLaunchctl = vi.hoisted(() => vi.fn(async () => state.launchctl));

vi.mock("./launchd-exec.js", () => ({
  execLaunchctl,
  isLaunchctlNotLoaded: (result: { stdout: string; stderr: string }) =>
    /could not find service|no such process|not found/i.test(result.stderr || result.stdout),
  formatLaunchctlResultDetail: (result: { stdout: string; stderr: string }) =>
    (result.stderr || result.stdout).trim(),
}));

const execFileUtf8 = vi.hoisted(() =>
  vi.fn(async (_command: string, args: string[]) => {
    const target = args.at(-1) ?? "";
    const label = state.plutilLabels.get(target);
    if (label !== undefined) {
      return { stdout: `${label}\n`, stderr: "", code: 0 };
    }
    // Matches the real plutil failure for a readable plist with no Label key.
    return {
      stdout: "",
      stderr:
        state.plutilErrors.get(target) ??
        `${target}: Could not extract value, error: No value at that key path or invalid key path: Label`,
      code: 1,
    };
  }),
);

vi.mock("./exec-file.js", () => ({ execFileUtf8 }));

import {
  assertNoSystemLaunchDaemonOwnership,
  inspectSystemLaunchDaemonOwnership,
  renderSystemLaunchDaemonOwnershipShellProbe,
} from "./launchd-system.js";

describe("system LaunchDaemon ownership", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    vi.clearAllMocks();
    state.launchctl = { stdout: "", stderr: "Could not find service", code: 113 };
    state.files.clear();
    state.accessErrors.clear();
    state.readdirError = "";
    state.plutilLabels.clear();
    state.plutilErrors.clear();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", {
        ...originalPlatformDescriptor,
        value: "darwin",
      });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("uses the readable system-domain query and reports a loaded owner", async () => {
    state.launchctl = { stdout: "state = running", stderr: "", code: 0 };

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "loaded",
      serviceTarget: "system/ai.openclaw.gateway",
    });
    expect(execLaunchctl).toHaveBeenCalledWith(["print", "system/ai.openclaw.gateway"]);
  });

  it("fails closed when launchctl cannot classify system ownership", async () => {
    state.launchctl = { stdout: "", stderr: "Operation not permitted", code: 1 };

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "unverifiable",
      serviceTarget: "system/ai.openclaw.gateway",
      operation: "launchctl",
      detail: "Operation not permitted",
    });
  });

  it("detects the canonical unloaded plist by its structural Label", async () => {
    const plistPath = "/Library/LaunchDaemons/ai.openclaw.gateway.plist";
    state.files.set(plistPath, "bplist00-binary-payload");
    state.plutilLabels.set(plistPath, "ai.openclaw.gateway");

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "installed",
      serviceTarget: "system/ai.openclaw.gateway",
      plistPath,
    });
  });

  it("detects a noncanonical XML plist by its decoded Label", async () => {
    const plistPath = "/Library/LaunchDaemons/vendor-openclaw.plist";
    state.files.set(
      plistPath,
      "<plist><dict><key>Label</key><string>ai.openclaw.gateway</string></dict></plist>",
    );
    state.plutilLabels.set(plistPath, "ai.openclaw.gateway");

    const ownership = await inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway");

    expect(ownership).toMatchObject({ status: "installed", plistPath });
    expect(execFileUtf8).toHaveBeenCalled();
  });

  it("uses the native top-level Label instead of an earlier nested XML key", async () => {
    const plistPath = "/Library/LaunchDaemons/nested-label.plist";
    state.files.set(
      plistPath,
      "<plist><dict><key>EnvironmentVariables</key><dict><key>Label</key><string>nested</string></dict><key>Label</key><string>ai.openclaw.gateway</string></dict></plist>",
    );
    state.plutilLabels.set(plistPath, "ai.openclaw.gateway");

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toMatchObject({
      status: "installed",
      plistPath,
    });
  });

  it("uses native plutil for binary and non-XML plist formats", async () => {
    const plistPath = "/Library/LaunchDaemons/binary-openclaw.plist";
    state.files.set(plistPath, "bplist00-binary-payload");
    state.plutilLabels.set(plistPath, "ai.openclaw.gateway");

    const ownership = await inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway");

    expect(ownership).toMatchObject({ status: "installed", plistPath });
    expect(execFileUtf8).toHaveBeenCalledWith("/usr/bin/plutil", [
      "-extract",
      "Label",
      "raw",
      "-o",
      "-",
      "--",
      plistPath,
    ]);
  });

  it("ignores a readable vendor plist that carries no Label key", async () => {
    // Regression: an inert third-party stub (an empty plist) used to make the
    // whole scan unverifiable and blocked every gateway service mutation.
    const unlabeled = "/Library/LaunchDaemons/com.google.keystone.daemon.plist";
    state.files.set(unlabeled, "<plist><dict/></plist>");

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "absent",
      serviceTarget: "system/ai.openclaw.gateway",
    });
  });

  it("keeps scanning past an unlabeled plist to find a real same-label owner", async () => {
    // "a.vendor" sorts ahead of "ai.openclaw", so the unlabeled entry is read first.
    const unlabeled = "/Library/LaunchDaemons/a.vendor.unlabeled.plist";
    const plistPath = "/Library/LaunchDaemons/ai.openclaw.gateway.plist";
    state.files.set(unlabeled, "<plist><dict/></plist>");
    state.files.set(plistPath, "<plist/>");
    state.plutilLabels.set(plistPath, "ai.openclaw.gateway");

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "installed",
      serviceTarget: "system/ai.openclaw.gateway",
      plistPath,
    });
  });

  it("ignores a plist whose Label is present but empty", async () => {
    const emptyLabel = "/Library/LaunchDaemons/com.vendor.empty-label.plist";
    state.files.set(emptyLabel, "<plist/>");
    state.plutilLabels.set(emptyLabel, "");

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "absent",
      serviceTarget: "system/ai.openclaw.gateway",
    });
  });

  it("still fails closed when a plist cannot be parsed at all", async () => {
    const corrupt = "/Library/LaunchDaemons/com.vendor.corrupt.plist";
    state.files.set(corrupt, "not-a-plist");
    state.plutilErrors.set(corrupt, `${corrupt}: Property List error: Unexpected character b`);

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "unverifiable",
      serviceTarget: "system/ai.openclaw.gateway",
      operation: "filesystem",
      detail: `${corrupt}: ${corrupt}: Property List error: Unexpected character b`,
    });
  });

  it("fails closed on an unreadable noncanonical vendor plist", async () => {
    const unrelated = "/Library/LaunchDaemons/com.vendor.locked.plist";
    state.files.set(unrelated, "<plist/>");
    state.accessErrors.set(unrelated, "EACCES");

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "unverifiable",
      serviceTarget: "system/ai.openclaw.gateway",
      operation: "filesystem",
      detail: `${unrelated}: EACCES: ${unrelated}`,
    });
  });

  it("rechecks the system domain after a negative plist snapshot", async () => {
    execLaunchctl
      .mockResolvedValueOnce({ stdout: "", stderr: "Could not find service", code: 113 })
      .mockResolvedValueOnce({ stdout: "state = running", stderr: "", code: 0 });

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "loaded",
      serviceTarget: "system/ai.openclaw.gateway",
    });
    expect(execLaunchctl).toHaveBeenCalledTimes(2);
  });

  it("can skip the installed-plist scan for read-only status probes", async () => {
    const plistPath = "/Library/LaunchDaemons/ai.openclaw.gateway.plist";
    state.files.set(plistPath, "<plist/>");

    await expect(
      inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        scanInstalledPlists: false,
      }),
    ).resolves.toEqual({
      status: "absent",
      serviceTarget: "system/ai.openclaw.gateway",
    });
  });

  it("throws one typed recovery error and documents that force cannot bypass it", async () => {
    state.launchctl = { stdout: "state = running", stderr: "", code: 0 };

    const error = await assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway").catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      name: "SystemLaunchDaemonOwnershipError",
      code: "SYSTEM_LAUNCH_DAEMON_OWNERSHIP",
      ownership: { status: "loaded", serviceTarget: "system/ai.openclaw.gateway" },
    });
    expect(String(error)).toContain("duplicate KeepAlive managers can restart-loop the gateway");
    expect(String(error)).toContain("--force does not override system ownership");
    expect(String(error)).toContain("sudo launchctl bootout system/ai.openclaw.gateway");
  });

  it("renders a standalone loaded and structural same-label plist probe", () => {
    const script = renderSystemLaunchDaemonOwnershipShellProbe("ai.openclaw.gateway");

    expect(script).toContain('launchctl print "$openclaw_system_launchd_target"');
    expect(script.match(/launchctl print "\$openclaw_system_launchd_target"/g)).toHaveLength(2);
    expect(script).toContain(
      '/usr/bin/plutil -extract Label raw -o - -- "$openclaw_system_launchd_plist"',
    );
    expect(script).toContain(
      "/usr/bin/find \"$openclaw_system_launchd_dir\" -mindepth 1 -maxdepth 1 -name '*.plist' -print0",
    );
    expect(script).toContain("while IFS= read -r -d '' openclaw_system_launchd_plist");
    expect(script).toContain('[ ! -x "$openclaw_system_launchd_dir" ]');
    expect(script).not.toContain('"$openclaw_system_launchd_dir"/*.plist');
    expect(script).toContain(
      'if [ "$openclaw_system_launchd_plist_label" != "$openclaw_system_launchd_label" ]',
    );
    // The detached restart path must skip unlabeled plists like the in-process scan.
    expect(script).toContain("no value at that key path|invalid key path");
    expect(script).not.toContain("|| true");
  });
});
