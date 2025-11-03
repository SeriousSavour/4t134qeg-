// index.js
const express = require("express");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.status(200).send("✅ Engine up. Connect via WebSocket."));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/version", async (_req, res) => {
  try {
    const path = await chromium.executablePath();
    res.json({ executablePath: path, node: process.version });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Listening on ${PORT}`);
});

const wss = new WebSocketServer({ server });

let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;

  const execPath = process.env.CHROME_PATH || (await chromium.executablePath());
  console.log("🔎 Launching Chromium at:", execPath);

  // Some platforms need these extra flags to avoid crashes
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
    headless: chromium.headless,        // use library’s recommended setting
    args,
    defaultViewport: chromium.defaultViewport,
  });

  console.log("🧊 Browser launched");
  return _browser;
}

wss.on("connection", async (ws) => {
  console.log("🟢 WS client connected");
  let context, page;
  try {
    const browser = await getBrowser();
    context = await browser.createIncognitoBrowserContext();
    page = await context.newPage();
  } catch (e) {
    console.error("❌ Could not open context/page:", e);
    ws.close();
    return;
  }

  ws.on("message", async (buf) => {
    try {
      const { type, data } = JSON.parse(buf.toString());
      if (type === "navigate") {
        console.log("🌐 navigate:", data.url);
        await page.goto(data.url, { waitUntil: "networkidle0", timeout: 45000 });
      } else if (type === "click") {
        await page.mouse.click(data.x, data.y);
      } else if (type === "scroll") {
        await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: data.x, y: data.y });
      } else if (type === "keypress") {
        await page.keyboard.type(data.text);
      }
    } catch (e) {
      console.error("WS msg error:", e);
    }
  });

  let streaming = true;
  (async function loop() {
    while (streaming && ws.readyState === ws.OPEN) {
      try {
        const img = await page.screenshot({ type: "jpeg", quality: 70 });
        ws.send(JSON.stringify({ type: "frame", base64: img.toString("base64") }));
      } catch (e) {
        console.error("frame error:", e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  })();

  ws.on("close", async () => {
    streaming = false;
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    console.log("🔴 WS client disconnected");
  });
});

// Log unhandled errors instead of hard-crashing
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
