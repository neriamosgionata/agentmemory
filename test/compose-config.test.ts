import { describe, it, expect } from "vitest";
import {
  COMPOSE_WORKER_VERSIONS,
  isComposeEngineVersion,
  renderComposeEnv,
  renderWorkerCompose,
} from "../src/cli/compose-config.js";

describe("isComposeEngineVersion", () => {
  it("treats 0.23+ as compose-only", () => {
    expect(isComposeEngineVersion("0.23.0")).toBe(true);
    expect(isComposeEngineVersion("0.24.0")).toBe(true);
    expect(isComposeEngineVersion("1.0.0")).toBe(true);
  });

  it("keeps the legacy worker list for 0.22 and below", () => {
    expect(isComposeEngineVersion("0.11.2")).toBe(false);
    expect(isComposeEngineVersion("0.22.1")).toBe(false);
    expect(isComposeEngineVersion("garbage")).toBe(false);
  });
});

describe("renderWorkerCompose", () => {
  const rendered = renderWorkerCompose({
    dataDir: "/var/lib/agentmemory",
    nodeBin: "/usr/bin/node",
    workerEntry: "/opt/agentmemory/dist/index.mjs",
    envFile: "/var/lib/agentmemory/compose.env",
    ports: { restPort: 3211, streamPort: 3212, viewerPort: 3213, enginePort: 49234 },
  });

  it("moves the engine-owned workers into engine.workers", () => {
    expect(rendered).toContain("namespace: default");
    expect(rendered).toContain("port: 49234");
    expect(rendered).toContain("port: 3212");
    expect(rendered).toContain("iii-sandbox:");
    expect(rendered).not.toContain("iii-observability");
  });

  it("declares registry containers with pinned versions and stored config", () => {
    expect(rendered).toContain(`package://state`);
    expect(rendered).toContain(COMPOSE_WORKER_VERSIONS.state);
    expect(rendered).toContain("config_name: state");
    expect(rendered).toContain("config_name: http");
    expect(rendered).toContain("port: 3211");
    expect(rendered).toContain("file_path: '/var/lib/agentmemory/state_store.db'");
  });

  it("runs the agentmemory worker through the app container", () => {
    expect(rendered).toContain("worker: path://.");
    expect(rendered).toContain("start_after: [state, http]");
    expect(rendered).toContain(
      "run: '/usr/bin/node /opt/agentmemory/dist/index.mjs'",
    );
    expect(rendered).toContain("env_file: ['/var/lib/agentmemory/compose.env']");
  });
});

describe("renderComposeEnv", () => {
  it("passes the instance ports and data dir to the app container", () => {
    const env = renderComposeEnv({
      dataDir: "/data",
      runtimeDir: "/data",
      ports: { restPort: 3211, streamPort: 3212, viewerPort: 3213 },
    });
    expect(env).toContain("AGENTMEMORY_DATA_DIR=/data");
    expect(env).toContain("III_REST_PORT=3211");
    expect(env).toContain("III_STREAM_PORT=3212");
    expect(env).toContain("III_VIEWER_PORT=3213");
    // The daemon injects III_URL and III_NAMESPACE; setting them is an error.
    expect(env).not.toContain("III_URL=");
    expect(env).not.toContain("III_NAMESPACE=");
  });
});
