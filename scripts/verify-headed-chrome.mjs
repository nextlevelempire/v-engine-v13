import { chromium } from "playwright";
import fs from "node:fs";

const executablePath = process.env.OMNI_CHROME_EXECUTABLE || "/opt/google/chrome/chrome";
const display = process.env.DISPLAY;

if (!display) {
  throw new Error("DISPLAY is not set. Headed Chrome requires a display server.");
}

if (!fs.existsSync(executablePath)) {
  throw new Error(`Chrome executable not found at ${executablePath}`);
}

const browser = await chromium.launch({
  executablePath,
  headless: false,
  args: [
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-setuid-sandbox",
    "--no-sandbox",
  ],
});

const page = await browser.newPage();
await page.goto("data:text/html,<h1>OMNI headed browser launch OK</h1>");
const text = await page.textContent("h1");

if (text !== "OMNI headed browser launch OK") {
  throw new Error(`Unexpected headed Chrome proof text: ${text}`);
}

console.log(JSON.stringify({ ok: true, display, executablePath, proof: text }));

await browser.close();
