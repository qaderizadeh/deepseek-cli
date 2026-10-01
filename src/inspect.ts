import { launchPersistent } from "./browser.js";
import { ensureLoggedIn } from "./auth.js";
import { deepseek } from "./sites.js";

const context = await launchPersistent({ profileDir: "./.profile" });
const page = await ensureLoggedIn(context, {
  url: deepseek.url,
  isLoggedIn: deepseek.isLoggedIn,
});

// Start a fresh chat so the toggle buttons render.
await deepseek.newChat(page);
await page.waitForTimeout(1500);

const buttons = await page.locator("button").evaluateAll((els) =>
  els.map((el) => ({
    text: (el.textContent ?? "").trim().slice(0, 40),
    aria: el.getAttribute("aria-pressed"),
    dataState: el.getAttribute("data-state"),
    cls: el.className.slice(0, 60),
    visible: (el as HTMLElement).offsetParent !== null,
  })),
);

console.table(buttons.filter((b) => b.visible));

await page.waitForTimeout(60_000); // keep open to poke around
await context.close();