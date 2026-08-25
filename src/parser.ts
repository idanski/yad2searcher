import type { Page } from "patchright";
import type { ParsedListing } from "./types";
import { parsePrice, extractItemId } from "./utils";

export async function parseListingDetails(
  page: Page
): Promise<{ viewCount?: number; daysListed?: number; publishedDate?: string; description?: string; imageUrls?: string[]; hasBalcony?: boolean; hasElevator?: boolean; hasShelter?: boolean; publisherName?: string; phoneNumber?: string }> {
  const result: { viewCount?: number; daysListed?: number; publishedDate?: string; description?: string; imageUrls?: string[]; hasBalcony?: boolean; hasElevator?: boolean; hasShelter?: boolean; publisherName?: string; phoneNumber?: string } = {};

  try {
    const banner = await page
      .waitForSelector('div[class*="ad-seen-count-banner"]', { timeout: 3000 })
      .catch(() => null);
    if (banner) {
      const text = (await banner.textContent()) ?? "";
      const match = text.match(/(\d+)\s*פעמים\s*ב-\s*(\d+)\s*ימים/);
      if (match) {
        result.viewCount = parseInt(match[1], 10);
        result.daysListed = parseInt(match[2], 10);
      }
    }

    const dateEl = await page
      .waitForSelector('[data-testid="report-ad-label"]', { timeout: 3000 })
      .catch(() => null);
    if (dateEl) {
      const dateText = (await dateEl.textContent()) ?? "";
      const dateMatch = dateText.match(/(\d{2}\/\d{2}\/\d{2})/);
      if (dateMatch) {
        result.publishedDate = dateMatch[1];
      }
    }
    const descEl = await page
      .waitForSelector('[data-testid="property-description"]', { timeout: 3000 })
      .catch(() => null);
    if (descEl) {
      const descText = ((await descEl.textContent()) ?? "").trim();
      if (descText) {
        result.description = descText;
      }
    }

    // Parse amenities — prefer the structured grid, fall back to text search
    const amenityGrid = await page.$('[data-testid="in-property-grid"]');
    if (amenityGrid) {
      const gridText = ((await amenityGrid.textContent()) ?? "").toLowerCase();
      result.hasBalcony = gridText.includes("מרפסת");
      result.hasElevator = gridText.includes("מעלית");
      result.hasShelter = gridText.includes('ממ"ד') || gridText.includes("ממ״ד");
    } else {
      const pageText = await page.evaluate(() => document.body.innerText);
      result.hasBalcony = pageText.includes("מרפסת");
      result.hasElevator = pageText.includes("מעלית");
      result.hasShelter = pageText.includes('ממ"ד') || pageText.includes("ממ״ד");
    }

    // Wait for gallery section and images to render
    const gallerySection = await page
      .waitForSelector('[data-testid="item-gallery-section"]', { timeout: 5000 })
      .catch(() => null);

    if (gallerySection) {
      await gallerySection.scrollIntoViewIfNeeded().catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));

      const imageUrls = await page.$$eval(
        '[data-testid="item-gallery-section"] img[data-testid="image"]',
        (imgs) =>
          (imgs as HTMLImageElement[])
            .map((img) => img.src || img.dataset.src || "")
            .filter((src) => src.startsWith("http"))
      );
      console.log(`[parser] found ${imageUrls.length} gallery images`);
      if (imageUrls.length > 0) {
        result.imageUrls = [...new Set(imageUrls)];
      }
    } else {
      console.log("[parser] gallery section not found");
    }

    // Click "show phone number" button and wait for contact info to load
    const phoneSelector = 'a[data-testid="phone-number-link-anchor"]';
    const showContactsBtn = await page.$('button[data-testid="show-ad-contacts-button"]');
    if (showContactsBtn) {
      for (let phoneAttempt = 0; phoneAttempt < 2; phoneAttempt++) {
        await showContactsBtn.click();
        const phoneEl = await page.waitForSelector(phoneSelector, { timeout: 5000 }).catch(() => null);
        if (phoneEl) {
          const href = (await phoneEl.getAttribute("href")) ?? "";
          const phone = href.replace("tel:", "").trim();
          if (phone) result.phoneNumber = phone;
          break;
        }
        console.log(`[parser] phone not revealed after click attempt ${phoneAttempt + 1}, retrying...`);
      }
    }

    // Extract publisher name — broker listings use a data-testid, private listings use a data-testid or class fallback
    const brokerNameEl = await page.$('[data-testid="agency-ad-contact-info-name"]');
    const privateNameEl = await page.$('[data-testid="ad-contact-info-name"]') ?? await page.$('span[class*="ad-contact-info_name"]');
    const nameEl = brokerNameEl ?? privateNameEl;
    if (nameEl) {
      const name = ((await nameEl.textContent()) ?? "").trim();
      if (name) result.publisherName = name;
    }
  } catch (err) {
    console.error("[parser] error parsing listing details:", err);
  }

  const found = [
    result.phoneNumber && "phone",
    result.description && "description",
    result.publishedDate && "date",
    result.viewCount !== undefined && "views",
    result.publisherName && "publisher",
  ].filter(Boolean);
  const missing = [
    !result.phoneNumber && "phone",
    !result.description && "description",
    !result.publishedDate && "date",
    result.viewCount === undefined && "views",
    !result.publisherName && "publisher",
  ].filter(Boolean);
  console.log(`[parser] details — found: [${found.join(", ")}] | missing: [${missing.join(", ")}]`);

  return result;
}

const LISTING_SELECTOR = [
  'li[data-testid="platinum-item"]',
  'li[data-testid="item-basic"]',
  'li[data-testid="booster-item"]',
  'li[data-testid="agency-item"]',
].join(",");

const BASE_URL = "https://www.yad2.co.il";

export async function parseListings(page: Page): Promise<ParsedListing[]> {
  const rawItems = await page.$$eval(
    LISTING_SELECTOR,
    (elements, baseUrl) => {
      return elements.map((el) => {
        const linkEl = el.querySelector<HTMLAnchorElement>(
          "a[href*='/realestate/item/']"
        );
        const href = linkEl?.getAttribute("href") ?? "";

        const priceText =
          el.querySelector('[data-testid="price"]')?.textContent?.trim() ?? "";

        const street =
          el
            .querySelector('[data-testid="street-name"]')
            ?.textContent?.trim() ?? "";

        const infoLine1 =
          el
            .querySelector('[data-testid="item-info-line-1st"]')
            ?.textContent?.trim() ?? "";

        const infoLine2 =
          el
            .querySelector('[data-testid="item-info-line-2nd"]')
            ?.textContent?.trim() ?? "";

        const brokerSpan = el.querySelector<HTMLSpanElement>(
          "span[class*='abovePrice']"
        );
        const brokerText = brokerSpan?.textContent?.trim() ?? "";

        const testId = el.getAttribute("data-testid") ?? "";

        const hasPriceDrop =
          el.querySelector('[data-testid="ribbon-text-tag"]') !== null;

        const imgEl = el.querySelector<HTMLImageElement>('img[data-testid="image"]');
        const imageUrl = imgEl?.getAttribute("src") ?? "";

        const fullUrl = href ? baseUrl + href.split("?")[0] : "";

        return {
          href,
          priceText,
          street,
          infoLine1,
          infoLine2,
          brokerText,
          testId,
          hasPriceDrop,
          imageUrl,
          fullUrl,
        };
      });
    },
    BASE_URL
  );

  return rawItems
    .filter((item) => item.href)
    .map((item): ParsedListing => {
      return {
        itemId: extractItemId(item.href),
        street: item.street,
        infoLine1: item.infoLine1,
        infoLine2: item.infoLine2,
        price: parsePrice(item.priceText),
        priceText: item.priceText,
        isBroker: item.testId === "agency-item" || item.brokerText.length > 0,
        brokerText: item.brokerText,
        imageUrl: item.imageUrl || undefined,
        listingUrl: item.fullUrl,
        hasPriceDrop: item.hasPriceDrop,
      };
    });
}
