import { describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { assertLocalDockerBridgeReady, CappedLogPostgreSqlContainer } from "./pg-container.ts";

describe("Docker bridge preflight (EI-28142384637532617)", () => {
  const runtime = (socketPath = "/var/run/docker.sock", host = "localhost", operatingSystem = "Ubuntu") => ({
    container: { dockerode: { modem: { socketPath } } },
    info: { containerRuntime: { host, operatingSystem } },
  }) as unknown as Awaited<ReturnType<typeof getContainerRuntimeClient>>;
  const bridge = (name = "docker0") => ({ Driver: "bridge", Options: { "com.docker.network.bridge.name": name } });
  const defaults = { platform: "linux" as const, insideContainer: false };

  it("reports a missing bridge with the maintained SQL route", async () => {
    const client = runtime();
    const checkInterface = vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const inspectBridge = vi.fn().mockResolvedValue(bridge());
    await expect(assertLocalDockerBridgeReady(client, undefined, { ...defaults, inspectBridge, checkInterface }))
      .rejects.toThrow(/NETWORK NOT READY.*unavailable Linux bridge docker0.*with-test-pg\.mjs/);
    expect(checkInterface).toHaveBeenCalledExactlyOnceWith("docker0");
  });

  it("refuses bridge failure before upstream image pull, container startup or cleanup", async () => {
    const client = runtime();
    class Probe extends CappedLogPostgreSqlContainer {
      protected override runtimeClient() { return Promise.resolve(client); }
      protected override assertRuntimeReady(current: typeof client) {
        return assertLocalDockerBridgeReady(current, undefined, { ...defaults,
          inspectBridge: async () => bridge(), checkInterface: async () => { throw new Error("ENOENT"); } });
      }
    }
    const upstream = vi.spyOn(PostgreSqlContainer.prototype, "start");
    try {
      await expect(new Probe("pgvector/pgvector:pg18").start()).rejects.toThrow("NETWORK NOT READY");
      expect(upstream).not.toHaveBeenCalled();
    } finally { upstream.mockRestore(); }
  });

  it("rejects a malformed interface name before attempting a filesystem lookup", async () => {
    const checkInterface = vi.fn();
    await expect(assertLocalDockerBridgeReady(runtime(), "bridge", { ...defaults,
      inspectBridge: async () => bridge("../../wrong"), checkInterface,
    })).rejects.toThrow("invalid Docker bridge interface name");
    expect(checkInterface).not.toHaveBeenCalled();
  });

  it("checks the configured bridge afresh on each start, so later bridge loss is detected", async () => {
    const inspectBridge = vi.fn().mockResolvedValue(bridge("docker-test0"));
    const checkInterface = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ENOENT"));
    const deps = { ...defaults, inspectBridge, checkInterface };
    await expect(assertLocalDockerBridgeReady(runtime(), "bridge", deps)).resolves.toBeUndefined();
    await expect(assertLocalDockerBridgeReady(runtime(), "bridge", deps)).rejects.toThrow("docker-test0");
    expect(inspectBridge).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["remote daemon", runtime(undefined, "remote.example"), "bridge", defaults],
    ["TCP daemon", runtime(""), "bridge", defaults],
    ["rootless socket", runtime("/run/user/1000/docker.sock"), "bridge", defaults],
    ["Docker Desktop", runtime(undefined, undefined, "Docker Desktop"), "bridge", defaults],
    ["container namespace", runtime(), "bridge", { ...defaults, insideContainer: true }],
    ["macOS", runtime(), "bridge", { ...defaults, platform: "darwin" as const }],
    ["custom network", runtime(), "private-test-network", defaults],
    ["host network", runtime(), "host", defaults],
  ])("does not infer %s readiness from the caller's sysfs", async (_, client, mode, platform) => {
    const inspectBridge = vi.fn();
    await assertLocalDockerBridgeReady(client, mode, { ...platform, inspectBridge });
    expect(inspectBridge).not.toHaveBeenCalled();
  });

  it("bounds an unresponsive Docker inspection with actionable diagnostics", async () => {
    const checkInterface = vi.fn();
    await expect(assertLocalDockerBridgeReady(runtime(), "bridge", {
      ...defaults, inspectBridge: () => new Promise(() => {}), checkInterface, timeoutMs: 10,
    })).rejects.toThrow(/NETWORK NOT READY.*inspection timed out/);
    expect(checkInterface).not.toHaveBeenCalled();
  });

  it("preserves a Docker inspection failure instead of trying container startup", async () => {
    const failure = new Error("Docker socket denied");
    const error = await assertLocalDockerBridgeReady(runtime(), "bridge", {
      ...defaults, inspectBridge: async () => { throw failure; },
    }).catch(error => error);
    expect(error.cause).toBe(failure);
    expect(error.message).toContain("Docker socket denied");
  });
});
