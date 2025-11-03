// index.js
const express = require('express');
const { chromium } = require('playwright'); // Full browser engine
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.send('Add ?url=https://example.com');

  let browser;
  try {
    // Launch full headless Chromium
    browser = await chromium.launch({
      headless: true, // fully headless
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to target URL
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    // Get full HTML content
    const content = await page.content();
    res.send(content);

  } catch (err) {
    console.error(err);
    res.status(500).send(`Error fetching the URL: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`Cloud browser proxy running on port ${PORT}`);
  console.log(`Use: http://localhost:${PORT}/?url=https://example.com`);
});
