import path from "path";
import { chromium } from "patchright";
import type { BrowserContext, Page } from "patchright";
import { AppConfig } from "./types";
import { randomViewport, randomSleep, randomInt, randomUserAgent } from "./utils";

export class Crawler {
  private config: AppConfig;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async launch(): Promise<void> {
    const fs = await import("fs");
    fs.mkdirSync(this.config.browserDataDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(this.config.browserDataDir, {
      headless: this.config.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
      userAgent: randomUserAgent(),
      viewport: randomViewport(),
      locale: "he-IL",
      timezoneId: "Asia/Jerusalem",
      geolocation: { latitude: 32.08, longitude: 34.78 },
      permissions: ["geolocation"],
      extraHTTPHeaders: {
        "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    this.page = this.context.pages()[0] || await this.context.newPage();

    const browserVersion = await this.page.evaluate(() => navigator.userAgent).catch(() => "unknown");
    console.log(`[crawler] browser launched — UA: ${browserVersion}`);
  }

  async navigateToSearch(url: string): Promise<void> {
    if (!this.page) {
      throw new Error("Browser not launched. Call launch() first.");
    }

    const maxRetries = 4;
    const backoffMs = [30_000, 60_000, 120_000];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[crawler] navigating to: ${url} (attempt ${attempt}/${maxRetries})`);
      await this.page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });

      // Give Radware challenge JS time to resolve
      await new Promise((r) => setTimeout(r, 5000));

      const pageTitle = await this.page.title().catch(() => "unknown");
      const pageUrl = this.page.url();
      console.log(`[crawler] page title: "${pageTitle}" | URL: ${pageUrl}`);

      // Dump first 500 chars of HTML for debugging
      const htmlSnippet = await this.page.evaluate(() => document.documentElement.outerHTML.slice(0, 500)).catch(() => "could not read");
      console.log(`[crawler] HTML snippet: ${htmlSnippet}`);

      try {
        // Wait for the Radware challenge to resolve and the real Next.js page to swap in.
        await this.page.waitForSelector("#__NEXT_DATA__", { state: "attached", timeout: 30_000 });
        console.log("[crawler] challenge resolved, Next.js page loaded");

        // Now wait for the feed list to render
        await this.page.waitForSelector('ul[data-testid="feed-list"]', { timeout: 15_000 });
        await this.performMouseMovements();
        console.log("[crawler] search page loaded successfully");
        return;
      } catch {
        const screenshotPath = path.join(process.cwd(), `debug-attempt-${attempt}.png`);
        await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        const isCaptcha = pageTitle.toLowerCase().includes("captcha") || pageTitle.includes("ShieldSquare") || pageTitle.includes("Radware");
        console.warn(`[crawler] page did not load (attempt ${attempt}/${maxRetries}) — ${isCaptcha ? "CAPTCHA/Challenge detected" : `page: "${pageTitle}"`}`);
        console.warn(`[crawler] screenshot saved to: ${screenshotPath}`);

        if (attempt < maxRetries) {
          const waitMs = backoffMs[attempt - 1];
          console.log(`[crawler] backing off ${waitMs / 1000}s before retry...`);
          await new Promise((r) => setTimeout(r, waitMs));
          await this.page.reload({ waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    const fs = await import("fs");
    fs.rmSync(this.config.browserDataDir, { recursive: true, force: true });
    console.warn(`[crawler] cleared browser data at ${this.config.browserDataDir} to reset state`);

    throw new Error("Failed to load feed list after all retries — possible anti-bot block. Browser data has been cleared for next run.");
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("Browser not launched. Call launch() first.");
    }
    return this.page;
  }

  async goToNextPage(): Promise<boolean> {
    if (!this.page) {
      throw new Error("Browser not launched. Call launch() first.");
    }

    const nextButton = await this.page.$('a[aria-label="עמוד הבא"]');
    if (!nextButton) {
      console.log("[crawler] no next page button found");
      return false;
    }

    const isDisabled = await nextButton.evaluate(
      (el) => el.hasAttribute("aria-disabled") || el.classList.contains("disabled") || (el as HTMLButtonElement).disabled
    );
    if (isDisabled) {
      console.log("[crawler] next page button is disabled (last page)");
      return false;
    }

    const paginationText = await this.page.$eval(
      'span[class*="textVariant"]',
      (el) => el.textContent || ""
    ).catch(() => "");
    const pageMatch = paginationText.match(/(\d+)\s+מתוך\s+(\d+)/);
    if (pageMatch && pageMatch[1] === pageMatch[2]) {
      console.log("[crawler] already on last page");
      return false;
    }

    await this.performMouseMovements();
    await nextButton.click();
    await this.page.waitForSelector('ul[data-testid="feed-list"]', { timeout: 15000 });
    await randomSleep(this.config.minPageDelay, this.config.maxPageDelay);
    await this.performMouseMovements();

    console.log("[crawler] navigated to next page");
    return true;
  }

  async performMouseMovements(): Promise<void> {
    if (!this.page) {
      return;
    }

    const viewport = this.page.viewportSize();
    if (!viewport) {
      return;
    }

    const moveCount = randomInt(3, 6);

    for (let i = 0; i < moveCount; i++) {
      const x = randomInt(0, viewport.width - 1);
      const y = randomInt(0, viewport.height - 1);
      await this.page.mouse.move(x, y, { steps: randomInt(5, 15) });
      await new Promise((r) => setTimeout(r, randomInt(100, 500)));
    }

    if (Math.random() > 0.5) {
      await this.page.mouse.wheel(0, randomInt(100, 300));
    }
  }

  async navigateToListing(url: string): Promise<void> {
    if (!this.page) {
      throw new Error("Browser not launched. Call launch() first.");
    }

    console.log(`[crawler] navigating to listing: ${url}`);
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForSelector('h1[data-testid="heading"]', { timeout: 10000 });
    await this.performMouseMovements();
    console.log("[crawler] listing page loaded successfully");
  }

  async goBack(): Promise<void> {
    if (!this.page) {
      throw new Error("Browser not launched. Call launch() first.");
    }

    console.log("[crawler] going back to search results");
    await this.page.goBack({ waitUntil: "domcontentloaded" });
    await this.page.waitForSelector('ul[data-testid="feed-list"]', { timeout: 15000 });
    console.log("[crawler] back to search results");
  }

  async close(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close();
        console.log("[crawler] browser closed");
      }
    } catch (error) {
      console.error("[crawler] error closing browser:", error);
    }
  }
}
