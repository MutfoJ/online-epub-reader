import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "docs", "screenshots");
const demoTxt = path.join(repoRoot, "sample-books", "demo-novel.txt");

const baseUrl = process.env.BASE_URL || "https://novel-epub-reader.vercel.app";

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1200, height: 675 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();

  // Start clean every run.
  await context.clearCookies();

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".library-view", { timeout: 30_000 });

  // Import the demo novel to populate the UI.
  const fileInput = page.locator("#library-file-input");
  await fileInput.setInputFiles(demoTxt);

  // Import navigates straight into the reader.
  await page.waitForURL(/\/reader\//, { timeout: 30_000 });
  await page.waitForSelector(".reader-view", { timeout: 30_000 });

  // Reader screenshot (clean, no panels).
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "reader.png") });

  // Search screenshot (open panel and run a query).
  await page.getByRole("button", { name: "Search book" }).click();
  const searchInput = page.getByRole("searchbox", { name: "Search text" });
  await searchInput.fill("the");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, "search.png") });

  // Audio screenshot.
  await page.getByRole("button", { name: "Audio controls" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "audio.png") });

  // Library screenshot (go back with imported book visible).
  await page.getByRole("button", { name: "Back to library" }).click();
  await page.waitForURL(baseUrl + "/", { timeout: 30_000 }).catch(() => {});
  await page.waitForSelector(".library-view", { timeout: 30_000 });
  await page.waitForSelector(".book-card-v2", { timeout: 30_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "library.png") });

  await browser.close();

  // eslint-disable-next-line no-console
  console.log("Saved screenshots to", outDir);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
