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

// Baseline captured just before send.
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

function fingerprint(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 20);
}

function composerHas(composerText: string, fp: string): boolean {
  if (!fp) return true;
  return composerText.replace(/\s+/g, " ").includes(fp);
}

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
  const base = await page
    .evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      const last = els[els.length - 1] as HTMLElement | undefined;
      return { lastText: last ? last.textContent || "" : "" };
    }, answerSelector)
    .catch(() => ({ lastText: "" }));
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
 * Scroll the chat to bottom. Walks scrollable ancestors of the last answer
 * element AND the document-level scrollers.
 */
async function scrollToBottom(page: Page): Promise<void> {
  await page
    .evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      const last = els[els.length - 1] as HTMLElement | undefined;

      if (last) {
        try {
          last.scrollIntoView({ block: "end", behavior: "auto" });
        } catch {}

        let node: HTMLElement | null = last;
        while (node) {
          const style = getComputedStyle(node);
          const oy = style.overflowY;
          if (
            (oy === "auto" || oy === "scroll" || oy === "overlay") &&
            node.scrollHeight > node.clientHeight
          ) {
            node.scrollTop = node.scrollHeight;
          }
          node = node.parentElement;
        }
      }

      const doc = document.scrollingElement as HTMLElement | null;
      if (doc) doc.scrollTop = doc.scrollHeight;
      if (document.body) document.body.scrollTop = document.body.scrollHeight;
      if (document.documentElement) {
        document.documentElement.scrollTop =
          document.documentElement.scrollHeight;
      }
    }, answerSelector)
    .catch(() => {});
}

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

  let appeared = false;
  let scrollTick = 0;
  let lastHeartbeat = Date.now();

  while (Date.now() < deadline) {
    if (scrollTick++ % 6 === 0) await scrollToBottom(page);

    const state = await readAnswerState(page);

    if (state.count !== -1) {
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
 * Find the whole-message copy button for the *last assistant answer*.
 *
 * Positional rule — no dependence on wrapper class names:
 *   1. Locate the last `.ds-assistant-message-main-content`.
 *   2. Collect every copy-icon button on the page (svg path starting with
 *      the copy-icon prefix, not inside a code-block banner, not inside an
 *      answer's rendered content).
 *   3. Return the first candidate that appears *after* the last answer in
 *      document order. That's the toolbar button on the answer's own row.
 *
 * This works the same on Firefox, Chromium, WebKit, and Chrome/Edge channels,
 * regardless of how each browser serializes the surrounding wrapper classes.
 */
async function tagAnswerCopyButton(page: Page): Promise<Locator | null> {
  const marker = `cli-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const tagOnce = async (): Promise<boolean> => {
    return await page
      .evaluate(
        ([ansSel, prefix, mk]) => {
          const answers = document.querySelectorAll(ansSel);
          const last = answers[answers.length - 1] as HTMLElement | undefined;
          if (!last) return false;

          const buttons = Array.from(
            document.querySelectorAll('div[role="button"], [role="button"]'),
          ) as HTMLElement[];

          for (const el of buttons) {
            if (el.closest(".md-code-block-banner")) continue;
            if (el.closest(ansSel)) continue;
            const path = el.querySelector("svg path");
            const d = path?.getAttribute("d") ?? "";
            if (!d.startsWith(prefix)) continue;

            // DOCUMENT_POSITION_FOLLOWING === 4
            const pos = last.compareDocumentPosition(el);
            if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;

            el.setAttribute("data-cli-copy-target", mk);
            return true;
          }
          return false;
        },
        [answerSelector, copyIconPathPrefix, marker] as const,
      )
      .catch(() => false);
  };

  if (await tagOnce()) {
    return page.locator(`[data-cli-copy-target="${marker}"]`).first();
  }

  const answer = page.locator(answerSelector).last();
  await answer.scrollIntoViewIfNeeded().catch(() => {});
  await answer.hover({ force: true }).catch(() => {});
  await page.waitForTimeout(700);

  if (await tagOnce()) {
    return page.locator(`[data-cli-copy-target="${marker}"]`).first();
  }

  await scrollToBottom(page);
  await answer.hover({ force: true }).catch(() => {});
  await page.waitForTimeout(700);

  if (await tagOnce()) {
    return page.locator(`[data-cli-copy-target="${marker}"]`).first();
  }

  return null;
}

async function copyLastAnswer(page: Page): Promise<string> {
  await page.evaluate(() => {
    (window as any).__copiedText = "";
  });

  const button = await tagAnswerCopyButton(page);
  if (!button) {
    throw new Error("Copy button not found on the last answer message.");
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