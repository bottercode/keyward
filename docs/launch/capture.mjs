// Renders a page's render(t) to PNG frames with a throwaway headless Chrome over the DevTools protocol.
//   node capture.mjs <fps> <seconds> <outDir> [onlyTimes,comma,separated]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [fps = "30", seconds = "15", out = "frames", only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "keyward-capture-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1920,1080", "about:blank",
], { stdio: "ignore" });

let targets;
for (let i = 0; i < 50 && !targets; i++) {
  await new Promise((r) => setTimeout(r, 200));
  targets = await fetch("http://127.0.0.1:9333/json").then((r) => r.json()).catch(() => undefined);
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });

await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await send("Page.navigate", { url: "file://" + join(import.meta.dirname, process.env.PAGE ?? "index.html") });
await new Promise((r) => setTimeout(r, 1200));

const times = only ? only.split(",").map(Number) : Array.from({ length: Math.round(Number(fps) * Number(seconds)) }, (_, i) => i / Number(fps));
for (const [i, t] of times.entries()) {
  await send("Runtime.evaluate", { expression: `render(${t})` });
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
  writeFileSync(join(out, only ? `t-${t}.png` : `f${String(i).padStart(4, "0")}.png`), Buffer.from(shot.result.data, "base64"));
}
ws.close();
chrome.kill();
console.log(`${times.length} frames → ${out}`);
