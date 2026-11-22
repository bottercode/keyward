import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint, startServer, type Server, type State } from "../src/index.js";
import { fake, mockApi, put } from "./helpers.js";

function req(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-keyward": "1" }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, method, path, headers: { host: "localhost", ...headers, ...(data ? { "content-type": "application/json" } : {}) } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    r.on("error", reject);
    r.end(data);
  });
}

describe("dashboard actions", () => {
  let dir: string;
  let server: Server;
  let api: Awaited<ReturnType<typeof mockApi>>;
  const key = fake.openai();
  const other = fake.anthropic();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "keyward-sa-"));
    await put(dir, "code/app.ts", `const a = "${key}";\nconst b = "${other}";\n`);
    api = await mockApi({ "GET /v1/models": (r) => (r.headers.authorization === `Bearer ${key}` ? { json: {} } : { status: 401 }) });
    server = await startServer({ port: 0, scan: { roots: [join(dir, "code")], homeDir: dir }, verify: { bases: { openai: api.base } } });
    await server.idle();
  });
  afterAll(async () => {
    await server.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("checks a key without ever sending it to the page", async () => {
    const r = await req(server.port, "GET", `/api/verify?id=${fingerprint(key)}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ status: "live" });
    expect(r.body).not.toContain(key);
    const state = JSON.parse((await req(server.port, "GET", "/api/state")).body) as State;
    expect(state.verified[fingerprint(key)]?.status).toBe("live");
  });

  it("refuses actions without the header or as a form post", async () => {
    expect((await req(server.port, "GET", `/api/verify?id=${fingerprint(key)}`, undefined, {})).status).toBe(403);
    expect((await req(server.port, "POST", "/api/ignore", undefined, { "x-keyward": "1", "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
  });

  it("ignores a key", async () => {
    const r = await req(server.port, "POST", "/api/ignore", { id: fingerprint(other) });
    expect(r.status).toBe(200);
    expect(await readFile(join(dir, ".keywardignore"), "utf8")).toContain(fingerprint(other));
    const state = JSON.parse((await req(server.port, "GET", "/api/state")).body) as State;
    expect(state.result?.findings.map((f) => f.id)).toEqual([fingerprint(key)]);
  });

  it("rotates a key in place and rejects a wrong new key", async () => {
    const id = fingerprint(key);
    const plan = JSON.parse((await req(server.port, "GET", `/api/rotate/plan?id=${id}`)).body) as { steps: Array<{ kind: string }> };
    expect(plan.steps.some((s) => s.kind === "file")).toBe(true);
    expect((await req(server.port, "POST", "/api/rotate", { id, newKey: "nope" })).status).toBe(400);
    const next = fake.openai();
    const r = await req(server.port, "POST", "/api/rotate", { id, newKey: next });
    expect(r.status).toBe(200);
    expect(r.body).not.toContain(next);
    expect(await readFile(join(dir, "code/app.ts"), "utf8")).toContain(next);
    await server.idle();
  });
});
