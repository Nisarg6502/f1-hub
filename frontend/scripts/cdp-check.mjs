#!/usr/bin/env node
// Headless Chrome check: load a URL at a phone or desktop size, evaluate one
// JS expression in the page, optionally save a full-page screenshot.
//
//   node scripts/cdp-check.mjs --url <url> [--mobile] [--landscape]
//                              [--wait <ms>] [--eval "<js expression>"]
//                              [--shot <path.jpg>]
//
// Prints one JSON line -- {"ok":true,"value":...} or {"ok":false,"error":"..."}
// -- and always exits 0, so a caller reads the line rather than the exit code.
//
// No npm dependencies: Node 22 has a global WebSocket and fetch. Chrome is
// driven directly over the DevTools Protocol because the in-app preview pane
// never fires requestAnimationFrame (see the f1hub-preview-pane-raf-stall
// memory), which makes it useless for anything animated or Suspense-gated.
//
// On Windows from Git Bash, prefix a call with MSYS_NO_PATHCONV=1 if any
// argument starts with "/", or the shell rewrites it into a Windows path.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { wait: 3500, eval: "document.title" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--mobile") args.mobile = true;
    else if (flag === "--landscape") args.landscape = true;
    else if (flag === "--url") args.url = argv[++i];
    else if (flag === "--wait") args.wait = Number(argv[++i]);
    else if (flag === "--eval") args.eval = argv[++i];
    else if (flag === "--shot") args.shot = argv[++i];
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.url) throw new Error("--url is required");
  if (!Number.isFinite(args.wait) || args.wait < 0) throw new Error("--wait must be a number of milliseconds");
  return args;
}

async function run(args, profileDir) {
  const port = 9300 + Math.floor(Math.random() * 100);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      // Absolute on purpose: a relative profile directory makes the debug
      // port never open, with no error.
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--hide-scrollbars",
      "--use-angle=d3d11",
      "--enable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  let ws;
  try {
    let wsUrl;
    for (let i = 0; i < 100 && !wsUrl; i++) {
      await sleep(200);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        wsUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
      } catch {
        // Chrome is not listening yet.
      }
    }
    if (!wsUrl) throw new Error("Chrome did not open its debugging port within 20s");

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("could not connect to Chrome")), { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    const waiters = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method) {
        for (const waiter of waiters.splice(0)) waiter(message);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (reply.error) throw new Error(reply.error.message);
      const details = reply.result?.exceptionDetails;
      if (details) throw new Error(details.exception?.description || details.text || "evaluation failed");
      return reply.result?.result?.value;
    };
    const waitForEvent = (method, timeoutMs) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        const waiter = (message) => {
          if (message.method === method) {
            clearTimeout(timer);
            resolve(true);
          } else {
            waiters.push(waiter);
          }
        };
        waiters.push(waiter);
      });

    await send("Page.enable");
    await send("Runtime.enable");
    // The dev server's bundles use eval(), which the app's own CSP forbids.
    await send("Page.setBypassCSP", { enabled: true });

    let width = 1440;
    let height = 900;
    if (args.mobile || args.landscape) {
      [width, height] = args.landscape ? [844, 390] : [390, 844];
      await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await send("Emulation.setUserAgentOverride", { userAgent: IPHONE_UA });
    }
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: args.mobile || args.landscape ? 2 : 1,
      mobile: Boolean(args.mobile || args.landscape),
    });

    const loaded = waitForEvent("Page.loadEventFired", 45000);
    await send("Page.navigate", { url: args.url });
    if (!(await loaded)) throw new Error("page did not finish loading within 45s");
    await sleep(args.wait);
    // Walk the page so in-view reveals and lazy sections run, then come back.
    await evaluate(`(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 500) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 250));
      }
      scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 400));
    })()`);

    const value = await evaluate(args.eval);

    if (args.shot) {
      const docHeight = await evaluate("document.documentElement.scrollHeight");
      const shot = await send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 70,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: Math.min(docHeight || height, 8000), scale: 1 },
      });
      writeFileSync(args.shot, Buffer.from(shot.result.data, "base64"));
    }
    return { ok: true, value };
  } finally {
    try {
      ws?.close();
    } catch {
      // already closed
    }
    // Only the child this script spawned; never `taskkill /IM chrome.exe`.
    chrome.kill();
  }
}

const profileDir = mkdtempSync(join(tmpdir(), "apex-cdp-"));
let outcome;
try {
  outcome = await run(parseArgs(process.argv.slice(2)), profileDir);
} catch (error) {
  outcome = { ok: false, error: String(error?.message || error) };
}
console.log(JSON.stringify(outcome));
// Chrome may still hold profile files for a moment after kill on Windows.
await sleep(500);
try {
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // A leftover temp directory is harmless.
}
process.exit(0);
