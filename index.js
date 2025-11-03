// index.js
const express = require("express");
const { chromium } = require("playwright");
const { WebSocketServer } = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server so WebSocket can attach
const server = app.listen(PORT, () => {
  console.log(`🚀 Cloud Browser Engine running on port ${PORT}`);
});

// Attach WebSocket
const wss = new WebSocketServer({ server });

// Launch shared browser instance
let browserPromise = chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

wss.on("connection", async (ws) => {
  console.log("🟢 New WebSocket client connected.");

  const browser = await browserPromise;
  const context = await browser.newContext();
  const page = await context.newPage();

  // Incoming messages from client
  ws.on("message", async (msg) => {
    try {
      const { type, data } = JSON.parse(msg);

      if (type === "navigate") {
        console.log(`🌐 Navigating to ${data.url}`);
        await page.goto(data.url, { waitUntil: "networkidle" });
      }

      if (type === "click") {
        await page.mouse.click(data.x, data.y);
      }

      if (type === "scroll") {
        await page.evaluate(
          ({ x, y }) => window.scrollTo(x, y),
          { x: data.x, y: data.y }
        );
      }

      if (type === "keypress") {
        await page.keyboard.type(data.text);
      }

    } catch (err) {
      console.error("⚠️ WebSocket message error:", err);
    }
  });

  // Outgoing: continuously send screenshots to UI
  const sendFrame = async () => {
    if (ws.readyState === ws.OPEN) {
      try {
        const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
        ws.send(JSON.stringify({
          type: "frame",
          base64: screenshot.toString("base64"),
        }));
      } catch (err) {
        console.error("Frame capture error:", err.message);
      }
      setTimeout(sendFrame, 300); // send frames ~3fps (adjust as needed)
    }
  };

  sendFrame();

  ws.on("close", async () => {
    console.log("🔴 Client disconnected.");
    await context.close();
  });
});
