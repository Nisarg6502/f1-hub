#!/usr/bin/env node
/**
 * Records the looping clip on the home page's "Real-world circuits" widget.
 *
 * The clip is a capture of the real 3D viewer in Real world mode, slowly
 * orbiting the circuit, not a mock-up, so it can be remade whenever the scene's
 * look changes:
 *
 *   cd frontend && npm run dev            # in another terminal; needs .env.local
 *   node scripts/record-showcase.mjs --url http://localhost:3000 --circuit monaco
 *
 * Output lands in public/showcase/real-world-<circuit>.mp4 and .jpg, which is
 * what `components/home/widgets/real-world-widget.tsx` points at.
 *
 * How it works, because none of it is obvious:
 *   - It drives a headless Chrome over the DevTools Protocol with Node's global
 *     WebSocket, so it needs no npm dependency. Chrome is found at the usual
 *     Windows/macOS/Linux paths, or pass --chrome.
 *   - The recording is the WebGL canvas itself (`canvas.captureStream` into a
 *     `MediaRecorder`), so the viewer's HTML controls are not in the picture.
 *   - Headless Chrome must be given a real GPU (`--use-angle=d3d11 --enable-gpu`
 *     on Windows). Software rendering runs this scene at about 3 fps, and the
 *     clip would be a slideshow.
 *   - The viewer opens in Real world, in its three-quarter view. The script
 *     clicks the canvas to activate it, then drags the mouse slowly to orbit.
 *     (A "Fly the lap" capture was tried first: its chase camera sits at street
 *     level, where the satellite texture is at its muddiest.)
 *   - ffmpeg (must be on PATH, or pass --ffmpeg) crops to 16:9, scales to
 *     1280x720, fades in and out so the loop point is not a hard cut, and writes
 *     a web-friendly H.264 file with the index up front for instant start.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((token, i, all) =>
    token.startsWith("--") ? [[token.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]] : [],
  ),
);

const URL_BASE = (args.url ?? "http://localhost:3000").replace(/\/$/, "");
const CIRCUIT = args.circuit ?? "monaco";
const SECONDS = Number(args.seconds ?? 11);
// How far the mouse drags over the clip, in px. The viewer's orbit turns about
// 2*PI per canvas-height of drag, so -140 px on a 660 px canvas swings the
// camera roughly 75 degrees: enough to see the circuit change shape, slow
// enough to read as a calm flyover. Negative orbits one way, positive the other.
const SWEEP_PX = Number(args.sweep ?? -140);
const PORT = Number(args.port ?? 9333);
// How long to wait for the viewer's imagery to finish loading. Generous by
// default because a cold dev server compiles the circuit page on first request.
const WAIT_MS = Number(args.wait ?? 240000);
const FFMPEG = args.ffmpeg ?? "ffmpeg";
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "showcase");

const CHROME_CANDIDATES = [
  args.chrome,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error("Chrome not found; pass --chrome <path>");
if (spawnSync(FFMPEG, ["-version"]).status !== 0) throw new Error("ffmpeg not found; pass --ffmpeg <path>");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const profile = mkdtempSync(join(tmpdir(), "apex-showcase-"));

const gpuFlags =
  process.platform === "win32"
    ? ["--use-angle=d3d11", "--enable-gpu"]
    : ["--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist"];

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,1200",
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars",
    ...gpuFlags,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let socket;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((done, fail) => {
    const id = nextId++;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

/** Evaluate in the page and return the value, throwing the page's own error text. */
async function evaluate(expression, { awaitPromise = true } = {}) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page) {
        socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((done, fail) => {
          socket.onopen = done;
          socket.onerror = fail;
        });
        socket.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.error) waiter.fail(new Error(message.error.message));
          else waiter.done(message.result);
        };
        return;
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(500);
  }
  throw new Error("could not reach Chrome's DevTools port");
}

try {
  await connect();
  await send("Page.enable");
  // A dev server's bundles use `eval`, which the app's own Content-Security-Policy
  // (next.config.ts) refuses, leaving the page without any client JavaScript. This
  // browser only ever visits our own page, so let it through. Harmless against a
  // production build, which needs no eval.
  await send("Page.setBypassCSP", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${URL_BASE}/circuits/${CIRCUIT}` });

  // Wait for the viewer: a canvas, then for the satellite tiles to finish.
  // The first compile of a dev server can take a while, hence the patience.
  console.log("waiting for the viewer…");
  await evaluate(`new Promise((done, fail) => {
    const started = Date.now();
    const poll = () => {
      const canvas = document.querySelector("canvas");
      const loading = /Loading .*satellite imagery|Loading elevation/i.test(document.body.innerText);
      if (canvas && canvas.width > 300 && !loading) { settled = settled + 1; } else { settled = 0; }
      if (settled >= 6) return done(true);
      if (Date.now() - started > ${WAIT_MS}) {
        const canvasSize = canvas ? canvas.width + "x" + canvas.height : "none";
        return fail(new Error("viewer never finished loading; canvas " + canvasSize + "; page text: " + document.body.innerText.replace(/\\s+/g, " ").slice(0, 600)));
      }
      setTimeout(poll, 500);
    };
    let settled = 0;
    poll();
  })`);
  const real = await evaluate(`document.body.innerText.includes("Real world")`);
  if (!real) throw new Error("the Real world control is missing; is this the right build?");
  await sleep(2500);

  const size = await evaluate(`(() => { const c = document.querySelector("canvas"); return { w: c.width, h: c.height }; })()`);
  console.log(`canvas ${size.w}x${size.h}; recording ${SECONDS}s`);

  // Activate the viewer (it ignores the mouse until it is clicked), then record
  // while a slow mouse drag orbits the camera. The drag is eased in and out so
  // the loop point, which fades through black, never lands mid-swing.
  const mouse = (type, x, y, buttons) =>
    send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1 });
  const rect = await evaluate(`(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);
  await mouse("mousePressed", cx, cy, 1);
  await mouse("mouseReleased", cx, cy, 0);
  await sleep(800);

  await evaluate(`(() => {
    const canvas = document.querySelector("canvas");
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    window.__recording = new Promise((done, fail) => {
      recorder.onstop = () => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result).split(",")[1]);
        reader.onerror = () => fail(new Error("could not read the recording"));
        reader.readAsDataURL(new Blob(chunks, { type: "video/webm" }));
      };
    });
    window.__recorder = recorder;
    recorder.start(250);
  })()`, { awaitPromise: false });

  const ease = (t) => t * t * (3 - 2 * t);
  const began = Date.now();
  await mouse("mousePressed", cx, cy, 1);
  for (;;) {
    const t = (Date.now() - began) / (SECONDS * 1000);
    if (t >= 1) break;
    await mouse("mouseMoved", Math.round(cx + SWEEP_PX * ease(t)), cy, 1);
    await sleep(16);
  }
  await mouse("mouseReleased", Math.round(cx + SWEEP_PX), cy, 0);

  const base64 = await evaluate(`(() => { window.__recorder.stop(); return window.__recording; })()`);

  mkdirSync(OUT_DIR, { recursive: true });
  const raw = join(profile, "capture.webm");
  writeFileSync(raw, Buffer.from(base64, "base64"));
  console.log(`captured ${(base64.length * 0.75 / 1048576).toFixed(1)} MB of raw video`);

  const mp4 = join(OUT_DIR, `real-world-${CIRCUIT}.mp4`);
  const jpg = join(OUT_DIR, `real-world-${CIRCUIT}.jpg`);
  const fit = "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)',scale=1280:720:flags=lanczos";
  const fades = `fade=t=in:st=0:d=0.5,fade=t=out:st=${SECONDS - 0.6}:d=0.6`;
  const encode = spawnSync(
    FFMPEG,
    ["-y", "-loglevel", "error", "-i", raw, "-vf", `${fit},fps=30,${fades}`, "-an", "-c:v", "libx264",
     "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
    { stdio: "inherit" },
  );
  if (encode.status !== 0) throw new Error("ffmpeg could not encode the clip");

  // The still shown before the video loads, and to anyone who has asked for less motion.
  const still = spawnSync(
    FFMPEG,
    ["-y", "-loglevel", "error", "-ss", String(Math.min(5, SECONDS / 2)), "-i", raw, "-vf", fit,
     "-frames:v", "1", "-q:v", "4", jpg],
    { stdio: "inherit" },
  );
  if (still.status !== 0) throw new Error("ffmpeg could not write the poster");
  console.log(`wrote ${mp4}\nwrote ${jpg}`);
} finally {
  try {
    socket?.close();
  } catch {}
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
