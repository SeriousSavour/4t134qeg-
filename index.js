// index.js — Playwright + WS cloud browser (stable launcher + diagnostics)
const express = require("express");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static UI
app.use(express.static("public"));

// Health / debug
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/version", (_req, res) =>
  res.json({ engine: "playwright", node: process.version })
);

// Snapshot (no WS) — sanity check
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

// Default UI
app.get("/", (_req, res) => res.sendFile(__dirname + "/public/index.html"));

// Start HTTP
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Listening on ${PORT}`);
});
server.on("upgrade", (req) => console.log("🔁 HTTP upgrade:", req.url));

// WebSocket
const wss = new WebSocketServer({ server, path: "/ws" });

// --- Stable browser launcher with fallback ---
let browserPromise = null;
async function launchBrowserStable() {
  // Try Chrome channel (if present in image), then fallback to bundled Chromium
  const launchArgs = [
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--use-gl=swiftshader",
    "--disable-gpu",
  ];

  // 1) Try chrome channel
  try {
    console.log("🔎 Trying launch: channel=chrome …");
    const b = await chromium.launch({ channel: "chrome", headless: true, args: launchArgs });
    console.log("✅ Launched with channel=chrome");
    return b;
  } catch (e) {
    console.warn("⚠️ Chrome channel failed, falling back to bundled Chromium:", e.message);
  }

  // 2) Fallback to default Chromium
  console.log("🔎 Trying launch: bundled Chromium …");
  const b = await chromium.launch({ headless: true, args: launchArgs });
  console.log("✅ Launched bundled Chromium");
  return b;
}

async function getBrowser() {
  if (!browserPromise) browserPromise = launchBrowserStable();
  return browserPromise;
}
// --------------------------------------------

wss.on("connection", async (ws, req) => {
  console.log("🟢 WS connected:", req.url);

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  let context, page;
  try {
    const browser = await getBrowser();

    // Realistic context; guard every option
    const viewport = { width: 1366, height: 768 };
    context = await browser.newContext({
      viewport,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      colorScheme: "dark",
      deviceScaleFactor: 1,
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });

    page = await context.newPage();
    await page.setViewportSize(viewport);

    // addInitScript must never throw — wrap in try
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        if (window.WebGLRenderingContext) {
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function (p) {
            if (p === 37445) return "Intel Inc.";
            if (p === 37446) return "Intel(R) UHD Graphics";
            return getParameter.call(this, p);
          };
        }
      } catch (e) {
        // ignore
      }
    });

    // Diagnostics — these never throw
    page.on("console", (msg) => console.log("📜 console:", msg.type(), msg.text()));
    page.on("pageerror", (err) => console.error("💥 pageerror:", err));
    page.on("requestfailed", (req) =>
      console.error("⛔ requestfailed:", req.url(), req.failure()?.errorText)
    );
    page.on("response", (resp) => {
      if (resp.status() >= 400) console.error("⚠️ response", resp.status(), resp.url());
    });
  } catch (e) {
    console.error("❌ Could not open context/page:", e);
    try { ws.close(1011, "browser_launch_failed"); } catch {}
    return;
  }

  ws.on("message", async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const { type, data } = msg || {};
    try {
      if (type === "navigate" && data?.url) {
        console.log("🌐 navigate:", data.url);
        await page.goto(data.url, { waitUntil: "networkidle", timeout: 60000 });
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
      try { ws.send(JSON.stringify({ type: "error", message: String(e) })); } catch {}
    }
  });

  // stream frames
  let on = true;
  (async function loop() {
    while (on && ws.readyState === ws.OPEN) {
      try {
        const img = await page.screenshot({ type: "jpeg", quality: 70 });
        ws.send(JSON.stringify({ type: "frame", data: "data:image/jpeg;base64," + img.toString("base64") }));
      } catch (e) {
        console.error("frame error:", e.message);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();

  ws.on("close", async (code, reason) => {
    on = false;
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    console.log("🔴 WS disconnected", code, reason?.toString());
  });
});

// WS keepalive sweep
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

// Never crash the process
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
