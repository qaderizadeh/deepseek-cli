import type { BrowserContext, Page } from "playwright";

type EnsureLoggedInOptions = {
  url: string;
  isLoggedIn: (page: Page) => Promise<boolean>;
  timeoutMs?: number;
};

export async function ensureLoggedIn(
  context: BrowserContext,
  { url, isLoggedIn, timeoutMs = 5 * 60_000 }: EnsureLoggedInOptions,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  if (await isLoggedIn(page)) {
    console.log("Already logged in.");
    return page;
  }

  console.log("Not logged in. Please log in in the opened window...");
  await page.bringToFront();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (await isLoggedIn(page)) {
      console.log("Login detected.");
      return page;
    }
  }

  throw new Error("Login timed out.");
}