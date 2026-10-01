import type { Page, Locator } from "playwright";

export type Chat = {
  title: string;
  index: number;
  href: string | null;
};

const chatItemSelector = "a[href^='/chat/'], a[href^='/a/chat/']";
const inputSelector = "textarea, [contenteditable='true']";

const deepThinkSelector = ".ds-toggle-button:has-text('DeepThink')";
const searchSelector = ".ds-toggle-button:has-text('Search')";

// The assistant's rendered answer, confirmed from the DOM dump.
const answerSelector = ".ds-assistant-message-main-content";

// Classes that must never contribute text (code-block toolbars, buttons).
const skipClasses = [
  "md-code-block-banner",
  "md-code-block-banner-wrap",
  "code-info-button-text",
  "ds-button__content",
];

// The copy icon's SVG path starts with this exact prefix, both for the
// per-code-block copy and the whole-message copy.
const copyIconPathPrefix = "M6.14929 4.02032";

type Settings = { deepThink: boolean; search: boolean };

async function isLoggedIn(page: Page): Promise<boolean> {
  const loginButton = page.getByText(/log ?in/i).first();
  if (await loginButton.isVisible().catch(() => false)) return false;
  return page.locator(inputSelector).first().isVisible().catch(() => false);
}

async function listChats(page: Page): Promise<Chat[]> {
  await page.waitForSelector(chatItemSelector, { timeout: 10_000 }).catch(() => {});
  const items = page.locator(chatItemSelector);
  const count = await items.count();
  const chats: Chat[] = [];

  for (let i = 0; i < count; i++) {
    const el = items.nth(i);
    const raw = (await el.innerText().catch(() => "")).trim();
    if (!raw) continue;
    chats.push({
      title: raw.split("\n")[0],
      index: i,
      href: await el.getAttribute("href"),
    });
  }
  return chats;
}

async function openChat(page: Page, chat: Chat): Promise<void> {
  if (chat.href) {
    await page.goto(new URL(chat.href, "https://chat.deepseek.com").toString());
  } else {
    await page.locator(chatItemSelector).nth(chat.index).click();
  }
  await page.waitForLoadState("domcontentloaded");
}

async function newChat(page: Page): Promise<void> {
  await page.getByText(/new chat/i).first().click();
  await page.waitForLoadState("domcontentloaded");
}

async function readToggleState(locator: Locator): Promise<boolean> {
  const cls = (await locator.getAttribute("class")) ?? "";
  return cls.includes("ds-toggle-button--selected");
}

async function ensureToggle(
  page: Page,
  name: string,
  selector: string,
  desired: boolean,
): Promise<boolean> {
  const button = page.locator(selector).first();

  if (!(await button.isVisible().catch(() => false))) {
    console.log(`   ! Couldn't find ${name} toggle.`);
    return false;
  }

  const current = await readToggleState(button);
  if (current === desired) {
    console.log(`   ✓ ${name} is ${desired ? "on" : "off"}`);
    return true;
  }

  await button.click();
  await page.waitForTimeout(300);

  const after = await readToggleState(button);
  if (after === desired) {
    console.log(`   ✓ ${name} set to ${desired ? "on" : "off"}`);
    return true;
  }

  console.log(`   ! ${name} click didn't take effect.`);
  return false;
}

async function applySettings(page: Page, settings: Settings): Promise<boolean> {
  const a = await ensureToggle(page, "DeepThink", deepThinkSelector, settings.deepThink);
  const b = await ensureToggle(page, "Search", searchSelector, settings.search);
  return a && b;
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.locator(inputSelector).first();
  await input.waitFor({ state: "visible" });
  await input.click();
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
}

async function readLastAnswerText(page: Page): Promise<string> {
  const el = page.locator(answerSelector).last();
  return (await el.innerText().catch(() => "")) ?? "";
}

async function waitForCompletion(
  page: Page,
  stableMs = 2500,
  timeoutMs = 5 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // Phase 1 — wait for the answer element to appear.
  while (Date.now() < deadline) {
    const count = await page.locator(answerSelector).count();
    if (count > 0) break;
    await page.waitForTimeout(300);
  }

  // Phase 2 — poll until text length stops changing.
  let prevLen = -1;
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const text = await readLastAnswerText(page);
    const len = text.length;

    if (len > 0 && len === prevLen) {
      if (Date.now() - stableSince >= stableMs) return;
    } else {
      prevLen = len;
      stableSince = Date.now();
    }
    await page.waitForTimeout(400);
  }
}

/**
 * Find the whole-message Copy button.
 *
 * DeepSeek renders both the per-code-block copy and the whole-message copy
 * as `div[role="button"].ds-button` containing an SVG whose path starts
 * with the same `d` prefix. We match on that prefix, then exclude any
 * match nested inside `.md-code-block-banner` so only the whole-message
 * button remains. The toolbar only appears on hover, so we retry after
 * hovering the last answer.
 */
async function findAnswerCopyButton(page: Page): Promise<Locator | null> {
  const selector =
    `div[role="button"].ds-button:has(svg path[d^="${copyIconPathPrefix}"])`;

  const tryFind = async (): Promise<Locator | null> => {
    const candidates = page.locator(selector);
    const count = await candidates.count();

    // Walk bottom-up — the newest message's toolbar is last in the DOM.
    for (let i = count - 1; i >= 0; i--) {
      const el = candidates.nth(i);

      const inCodeBlock = await el
        .evaluate((n) => !!(n as HTMLElement).closest(".md-code-block-banner"))
        .catch(() => false);
      if (inCodeBlock) continue;

      if (await el.isVisible().catch(() => false)) return el;
    }
    return null;
  };

  // Try without hover first.
  let button = await tryFind();
  if (button) return button;

  // The message toolbar only appears on hover.
  const answer = page.locator(answerSelector).last();
  await answer.scrollIntoViewIfNeeded().catch(() => {});
  await answer.hover().catch(() => {});
  await page.waitForTimeout(600);

  button = await tryFind();
  return button;
}

async function copyLastAnswer(page: Page): Promise<string> {
  await page.evaluate(() => {
    (window as any).__copiedText = "";
  });

  const button = await findAnswerCopyButton(page);
  if (!button) {
    throw new Error("Copy button not found on the answer message.");
  }

  await button.click({ force: true });
  await page.waitForTimeout(600);

  // Prefer the intercepted value.
  let copied = await page.evaluate(() => (window as any).__copiedText ?? "");

  // Fall back to real clipboard read.
  if (!copied || !copied.trim()) {
    copied = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    });
  }
  return (copied as string) ?? "";
}

/**
 * Reconstruct markdown from the rendered answer DOM.
 * Used only when the copy button path fails entirely.
 */
async function readMarkdownFromDom(page: Page): Promise<string> {
  const container = page.locator(answerSelector).last();
  if (!(await container.isVisible().catch(() => false))) return "";

  return container.evaluate(
    (root, skip) => {
      const shouldSkip = (el: HTMLElement) => {
        const cls = (el.className ?? "").toString();
        return skip.some((c) => cls.includes(c));
      };

      const walk = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        if (node.nodeType !== Node.ELEMENT_NODE) return "";

        const el = node as HTMLElement;
        if (shouldSkip(el)) return "";

        const tag = el.tagName.toLowerCase();

        // Code fences: extract just <code>, ignore any banner siblings.
        if (tag === "pre") {
          const codeEl = el.querySelector("code");
          if (!codeEl) return "";
          const codeText = (codeEl.textContent ?? "").replace(/\n+$/, "");
          const langMatch = (codeEl.className ?? "").match(/language-([\w-]+)/);
          const lang = langMatch?.[1] ?? "";
          return `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
        }

        const inner = Array.from(el.childNodes).map(walk).join("");

        switch (tag) {
          case "h1": return `\n# ${inner}\n\n`;
          case "h2": return `\n## ${inner}\n\n`;
          case "h3": return `\n### ${inner}\n\n`;
          case "h4": return `\n#### ${inner}\n\n`;
          case "h5": return `\n##### ${inner}\n\n`;
          case "h6": return `\n###### ${inner}\n\n`;
          case "p": return `${inner}\n\n`;
          case "br": return `\n`;
          case "strong":
          case "b": return `**${inner}**`;
          case "em":
          case "i": return `*${inner}*`;
          case "code": return `\`${inner}\``;
          case "ul": return `\n${inner}\n`;
          case "ol": return `\n${inner}\n`;
          case "li": {
            const marker =
              el.parentElement?.tagName.toLowerCase() === "ol" ? "1. " : "- ";
            return `${marker}${inner.trim()}\n`;
          }
          case "a": {
            const href = el.getAttribute("href") ?? "";
            return href ? `[${inner}](${href})` : inner;
          }
          case "blockquote": return `\n> ${inner.trim()}\n\n`;
          case "hr": return `\n---\n\n`;
          case "tr": {
            const cells = Array.from(el.children).map((c) => walk(c).trim());
            return `| ${cells.join(" | ")} |\n`;
          }
          case "th":
          case "td": return inner;
          default: return inner;
        }
      };

      return walk(root).trim();
    },
    skipClasses,
  );
}

async function readAnswer(page: Page): Promise<string> {
  await waitForCompletion(page);

  // Preferred: real Copy button → exact markdown.
  try {
    const md = await copyLastAnswer(page);
    if (md.trim()) return md;
  } catch {
    // fall through
  }

  console.log("   (copy button unavailable, reconstructing markdown)");
  const fallback = await readMarkdownFromDom(page);
  if (!fallback.trim()) {
    throw new Error("Couldn't read the answer from the page.");
  }
  return fallback;
}

export const deepseek = {
  url: "https://chat.deepseek.com",
  isLoggedIn,
  listChats,
  openChat,
  newChat,
  applySettings,
  sendPrompt,
  readAnswer,
};