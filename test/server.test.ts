import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type Server, type State } from "../src/index.js";

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

describe("dashboard server", () => {
  let dir: string;
  let server: Server;
  const key = ["sk", "proj", randomBytes(40).toString("hex")].join("-");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "keyward-srv-"));
    await writeFile(join(dir, "app.js"), `const k = "${key}";\n`);
    server = await startServer({ port: 0, scan: { roots: [dir] } });
    await server.idle();
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the scan result, masked", async () => {
    const res = await get(server.port, "/api/state", { host: "localhost" });
    expect(res.status).toBe(200);
    const state = JSON.parse(res.body) as State;
    expect(state.scanning).toBe(false);
    expect(state.result?.findings).toHaveLength(1);
    expect(state.result?.findings[0]?.masked).toBe(`sk-proj-…${key.slice(-4)}`);
    expect(res.body).not.toContain(key);
  });

  it("serves the UI", async () => {
    const res = await get(server.port, "/", { host: "localhost" });
    expect(res.status).toBe(200);
    expect(res.body).toContain("keyward");
  });

  it("refuses other host names (DNS rebinding)", async () => {
    expect((await get(server.port, "/api/state", { host: "evil.example.com" })).status).toBe(403);
  });

  it("only rescans with the keyward header", async () => {
    expect((await get(server.port, "/api/rescan", { host: "localhost" })).status).toBe(403);
    expect((await get(server.port, "/api/rescan", { host: "localhost", "x-keyward": "1" })).status).toBe(200);
    await server.idle();
  });
});
