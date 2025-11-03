wss.on("connection", async (ws, req) => {
  console.log("🟢 WS connected:", req.url);

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  let context, page;
  try {
    const browser = await getBrowser();

    // Realistic desktop fingerprint
    const viewport = { width: 1366, height: 768 };
    context = await browser.newContext({
      viewport,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      colorScheme: "dark",
      deviceScaleFactor: 1,
      permissions: [], // add origins if you need geolocation/camera later
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    page = await context.newPage();

    // Pretend to be non-automation
    await page.addInitScript(() => {
      // hide webdriver
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // common WebGL vendor spoof
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return "Intel Inc.";          // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return "Intel(R) UHD Graphics"; // UNMASKED_RENDERER_WEBGL
        return getParameter.call(this, p);
      };
    });

    // Useful diagnostics
    page.on("console", msg => console.log("📜 console:", msg.type(), msg.text()));
    page.on("pageerror", err => console.error("💥 pageerror:", err));
    page.on("requestfailed", req => console.error("⛔ requestfailed:", req.url(), req.failure()?.errorText));
    page.on("response", resp => {
      if (resp.status() >= 400) console.error("⚠️ response", resp.status(), resp.url());
    });

    // Launch-time tuning (already in your getBrowser, but ensure args include these)
    // In getBrowser(): args: ["--disable-dev-shm-usage","--no-sandbox","--use-gl=swiftshader","--disable-gpu"]

    await page.setViewportSize(viewport);
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
        await page.goto(data.url, {
          waitUntil: "networkidle",
          timeout: 60000
        });
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
      // also tell the client so it can show a toast
      try { ws.send(JSON.stringify({ type: "error", message: String(e) })); } catch {}
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
      await new Promise(r => setTimeout(r, 250)); // a bit smoother
    }
  })();

  ws.on("close", async (code, reason) => {
    on = false;
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    console.log("🔴 WS disconnected", code, reason?.toString());
  });
});
