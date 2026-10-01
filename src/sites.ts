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

// Baseline captured just before send — used to distinguish the *new* answer
// from whatever was already on screen.
let answerBaselineCount = 0;
let answerBaselineText = "";

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

async function readComposerText(input: Locator): Promise<string> {
  return input
    .evaluate((el) => {
      if (el instanceof HTMLTextAreaElement) return el.value;
      return el.textContent ?? "";
    })
    .catch(() => "");
}

/** Collapse whitespace, trim, take first 20 chars. Both sides must use this. */
function fingerprint(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 20);
}

/** True if the normalized composer text contains the fingerprint of `text`. */
function composerHas(composerText: string, fp: string): boolean {
  if (!fp) return true;
  return composerText.replace(/\s+/g, " ").includes(fp);
}

/** Clear the composer via select-all + delete, then fill("") as a backstop. */
async function clearComposer(page: Page, input: Locator): Promise<void> {
  await input.click().catch(() => {});
  await page.waitForTimeout(80);
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});
  await page.waitForTimeout(80);
  await input.fill("").catch(() => {});
  await page.waitForTimeout(80);
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  // Snapshot pre-send state so we can tell the new answer apart from what
  // was already on screen.
  const base = await page
    .evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      const last = els[els.length - 1] as HTMLElement | undefined;
      return {
        count: els.length,
        lastText: last ? last.textContent || "" : "",
      };
    }, answerSelector)
    .catch(() => ({ count: 0, lastText: "" }));
  answerBaselineCount = base.count;
  answerBaselineText = base.lastText;

  const input = page.locator(inputSelector).first();
  await input.waitFor({ state: "visible" });
  await input.scrollIntoViewIfNeeded().catch(() => {});

  await clearComposer(page, input);

  await input.click().catch(() => {});
  await page.keyboard.insertText(text).catch(() => {});
  await page.waitForTimeout(250);

  const fp = fingerprint(text);
  let composer = await readComposerText(input);
  if (!composerHas(composer, fp)) {
    await input.fill(text).catch(() => {});
    await page.waitForTimeout(250);
    composer = await readComposerText(input);
    if (!composerHas(composer, fp)) {
      throw new Error(
        `Composer did not receive the prompt. Composer has: "${composer
          .replace(/\s+/g, " ")
          .slice(0, 80)}"`,
      );
    }
  }

  const deadline = Date.now() + 8000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;

    const sendBtn = page
      .locator(
        'div[role="button"].ds-button--primary.ds-button--circle, ' +
          'div[role="button"][aria-label*="send" i], ' +
          'button[aria-label*="send" i]',
      )
      .last();

    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn
        .evaluate((el) => (el as HTMLElement).click())
        .catch(() => {});
    }
    await input.press("Enter").catch(() => {});

    await page.waitForTimeout(500);

    const remaining = await readComposerText(input);
    if (!composerHas(remaining, fp)) return;
  }

  throw new Error(
    `Couldn't submit after ${attempt} attempts — composer still holds the prompt.`,
  );
}

/**
 * One-shot scroll to bottom. Single evaluate, no keyboard events.
 */
async function scrollToBottom(page: Page): Promise<void> {
  await page
    .evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      const last = els[els.length - 1] as HTMLElement | undefined;
      if (!last) return;
      let node: HTMLElement | null = last;
      while (node) {
        const style = getComputedStyle(node);
        if (
          node.scrollHeight > node.clientHeight &&
          /(auto|scroll)/.test(style.overflowY)
        ) {
          node.scrollTop = node.scrollHeight;
        }
        node = node.parentElement;
      }
    }, answerSelector)
    .catch(() => {});
}

/**
 * Fast state read. Uses textContent (no layout flush) — innerText was
 * forcing a full layout on every poll, which timed out on large chats.
 * Raced with an 8s budget so a stalled page can never freeze the loop.
 */
async function readAnswerState(
  page: Page,
): Promise<{ count: number; lastText: string }> {
  const timeout = new Promise<{ count: number; lastText: string }>((resolve) =>
    setTimeout(() => resolve({ count: -1, lastText: "" }), 8000),
  );

  const probe = page
    .evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      const last = els[els.length - 1] as HTMLElement | undefined;
      return {
        count: els.length,
        lastText: last ? last.textContent || "" : "",
      };
    }, answerSelector)
    .catch(() => ({ count: -1, lastText: "" }));

  return Promise.race([probe, timeout]);
}

/**
 * True if DeepSeek is currently generating a response (Stop button visible).
 */
async function isGenerating(page: Page): Promise<boolean> {
  const stop = page
    .locator(
      'button:has-text("Stop"), [role="button"]:has-text("Stop"), ' +
        '[aria-label*="stop" i], [aria-label*="Stop generating" i]',
    )
    .first();
  return stop.isVisible().catch(() => false);
}

async function waitForCompletion(
  page: Page,
  stableMs = 2500,
  timeoutMs = 5 * 60_000,
): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;

  await scrollToBottom(page);

  // Phase 1 — wait for the *new* answer to appear with non-empty, non-baseline
  // text. Uses text-change detection (not just count) so container reuse and
  // virtual-list recycling don't break it.
  let appeared = false;
  let scrollTick = 0;
  let lastHeartbeat = Date.now();
  let consecutiveTimeouts = 0;

  while (Date.now() < deadline) {
    if (scrollTick++ % 6 === 0) await scrollToBottom(page);

    const state = await readAnswerState(page);

    if (state.count === -1) {
      consecutiveTimeouts++;
      if (consecutiveTimeouts === 3) {
        console.log("   ! page evaluate is slow; still trying…");
      }
    } else {
      consecutiveTimeouts = 0;

      const textChanged =
        state.lastText.length > 0 && state.lastText !== answerBaselineText;
      if (textChanged) {
        appeared = true;
        break;
      }
    }

    if (Date.now() - lastHeartbeat > 15_000) {
      const secs = Math.round((Date.now() - start) / 1000);
      const gen = await isGenerating(page);
      console.log(
        gen
          ? `   … still generating (${secs}s)`
          : `   … waiting for response (${secs}s)`,
      );
      lastHeartbeat = Date.now();
    }

    await page.waitForTimeout(500);
  }

  if (!appeared) {
    throw new Error(
      `No answer appeared within ${Math.round(timeoutMs / 1000)}s.`,
    );
  }

  // Phase 2 — wait for the text to stop growing.
  let prevLen = -1;
  let stableSince = Date.now();
  scrollTick = 0;

  while (Date.now() < deadline) {
    if (scrollTick++ % 6 === 0) await scrollToBottom(page);

    const state = await readAnswerState(page);
    const len = state.count === -1 ? prevLen : state.lastText.length;

    if (len > 0 && len === prevLen) {
      if (Date.now() - stableSince >= stableMs) return;
    } else {
      prevLen = len;
      stableSince = Date.now();
    }
    await page.waitForTimeout(500);
  }
}

/**
 * Find the whole-message Copy button that belongs to the *last assistant
 * answer*. DeepSeek renders the same copy icon on user messages too, so we
 * restrict the search to buttons that are NOT inside an answer's content
 * and NOT inside a code-block banner.
 */
async function findAnswerCopyButton(page: Page): Promise<Locator | null> {
  await scrollToBottom(page);

  const answer = page.locator(answerSelector).last();
  if ((await answer.count()) === 0) return null;

  const buttonSelector = `div[role="button"].ds-button:has(svg path[d^="${copyIconPathPrefix}"])`;

  const tryFind = async (): Promise<Locator | null> => {
    const all = page.locator(buttonSelector);
    const count = await all.count();

    for (let i = count - 1; i >= 0; i--) {
      const btn = all.nth(i);

      const ok = await btn
        .evaluate((node, ansSel) => {
          const el = node as HTMLElement;
          if (el.closest(".md-code-block-banner")) return false;
          if (el.closest(ansSel)) return false;
          if (!el.closest(".ds-message, [data-virtual-list-item-key]"))
            return false;
          return true;
        }, answerSelector)
        .catch(() => false);

      if (!ok) continue;
      if (await btn.isVisible().catch(() => false)) return btn;
    }
    return null;
  };

  let button = await tryFind();
  if (button) return button;

  await answer.hover({ force: true }).catch(() => {});
  await page.waitForTimeout(700);

  button = await tryFind();
  if (button) return button;

  await scrollToBottom(page);
  await answer.hover({ force: true }).catch(() => {});
  await page.waitForTimeout(700);

  return tryFind();
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

  let copied = await page.evaluate(() => (window as any).__copiedText ?? "");

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
  await scrollToBottom(page);

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