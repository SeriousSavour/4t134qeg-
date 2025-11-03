// index.js — Playwright + WS cloud browser (same-origin UI + diagnostics)
const express = require("express");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve UI from /public
app.use(express.static("public"));

// Health + debug
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/version", (_req, res) => res.json({ engine: "playwright:chromium", node: process.version }));

// QUICK DIAG: take a screenshot without WS
app.get("/snap", async (req, res) => {
  const url = req.query.url || "https://example.com";
  try {
    const browser = await getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    const buf = await page.screenshot({ type: "jpeg", quality: 70 });
    await context.close();
    res.set("Content-Type", "image/jpeg");
    res.send(buf);
  } catch (e) {
    console.error("SNAP ERROR:", e);
    res.status(500).send("snap failed: " + e.message);
  }
});

// Default route shows the UI
app.get("/", (_req, res) => res.sendFile(__dirname + "/public/index.html"));

// Start HTTP (needed for WS)
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Listening on ${PORT}`);
});
server.on("upgrade", (req) => console.log("🔁 HTTP upgrade:", req.url));

// WebSocket on explicit path
const wss = new WebSocketServer({ server, path: "/ws" });

// Launch one shared browser lazily (Playwright image contains Chromium)
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    console.log("🔎 Launching Playwright Chromium...");
    browserPromise = chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"]
    });
  }
  return browserPromise;
}

wss.on("connection", async (ws, req) => {
  console.log("🟢 WS connected:", req.url);

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // open isolated tab
  let context, page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext();
    page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
  } catch (e) {
    console.error("❌ Could not open context/page:", e);
    try { ws.close(1011, "browser_launch_failed"); } catch {}
    return;
  }

  // incoming commands
  ws.on("message", async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const { type, data } = msg || {};
    try {
      if (type === "navigate" && data?.url) {
        console.log("🌐 navigate:", data.url);
        await page.goto(data.url, { waitUntil: "networkidle", timeout: 45000 });
      } else if (type === "click" && data) {
        await page.mouse.click(data.x, data.y);
      } else if (type === "scroll" && data) {
        await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: data.x, y: data.y });
      } else if (type === "keypress" && data?.text) {
        await page.keyboard.type(data.text);
      } else if (type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (e) {
      console.error("WS msg error:", e);
    }
  });

  // stream frames → data URL
  let on = true;
  (async function loop() {
    while (on && ws.readyState === ws.OPEN) {
      try {
        const img = await page.screenshot({ type: "jpeg", quality: 70 });
        const dataUrl = "data:image/jpeg;base64," + img.toString("base64");
        ws.send(JSON.stringify({ type: "frame", data: dataUrl }));
      } catch (e) {
        console.error("frame error:", e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  })();

  ws.on("close", async (code, reason) => {
    on = false;
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    console.log("🔴 WS disconnected", code, reason?.toString());
  });
});

// sweep dead sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

// don’t crash on unhandled errors
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
