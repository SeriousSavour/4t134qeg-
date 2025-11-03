wss.on("connection", async (ws, req) => {
  console.log("🟢 WS connected:", req.url);

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

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

  ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
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

  ws.on("close", async () => {
    on = false;
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    console.log("🔴 WS disconnected");
  });
});
