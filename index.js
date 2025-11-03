// index.js
const express = require("express");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve your UI (put files in /public)
app.use(express.static("public"));

// Health + debug
app.get("/", (_req, res) => res.status(200).sendFile(__dirname + "/public/index.html"));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/version", async (_req, res) => {
  try {
    const path = await chromium.executablePath();
    res.json({ executablePath: path, node: process.version });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Start HTTP server (needed for WS)
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Listening on ${PORT}`);
});
server.on("upgrade", (req) => console.log("🔁 HTTP upgrade:", req.url));

// WebSocket on explicit path
const wss = new WebSocketServer({ server, path: "/ws" });

// Lazy browser launcher
let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;

  const execPath = process.env.CHROME_PATH || (await chromium.executablePath());
  console.log("🔎 Launching Chromium at:", execPath);

  const args = [
    ...chromium.args,
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
    "--single-process",
  ];

  _browser = await puppeteer.launch({
    executablePath: execPath,
    headless: chromium.headless,
    args,
    defaultViewport: chromium.defaultViewport,
  });

  console.log("🧊 Browser launched");
  return _browser;
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
    context = await browser.createIncognitoBrowserContext();
    page = await context.newPage();
    await page.setViewport({ width: 1280, height: 720 });
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
        await page.goto(data.url, { waitUntil: "networkidle0", timeout: 45000 });
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

  // stream frames → data URL (common client expectation)
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
      await new Promise(r => setTimeout(r, 300)); // ~3fps
    }
  })();

  ws.on("close", async () => {
    on = false;
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    console.log("🔴 WS disconnected");
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
