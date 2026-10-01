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

const answerSelector = ".ds-assistant-message-main-content";

const skipClasses = [
  "md-code-block-banner",
  "md-code-block-banner-wrap",
  "code-info-button-text",
  "ds-button__content",
];

const copyIconPathPrefix = "M6.14929 4.02032";

const answerTargetAttr = "data-cli-answer-target";

let answerBaselineCount = 0;
let answerBaselineText = "";

type Settings = { deepThink: boolean; search: boolean };

async function isLoggedIn(page: Page): Promise<boolean> {
  const loginButton = page.getByText(/log ?in/i).first();
  if (await loginButton.isVisible().catch(() => false)) return false;
  return page.locator(inputSelector).first().isVisible().catch(() => false);
}

/**
 * Best-effort: dismiss the cookie banner and any other overlay that could
 * sit on top of chat elements. Safe to call repeatedly.
 */
async function dismissOverlays(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const selectors = [
        ".cookie_banner-wrap",
        ".cookie_banner",
        "[class*='cookie_banner']",
        "[class*='CookieBanner']",
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          try {
            (el as HTMLElement).style.display = "none";
            el.remove();
          } catch {}
        });
      }
      // Try common accept buttons too.
      const buttons = Array.from(document.querySelectorAll("button, [role='button']")) as HTMLElement[];
      for (const b of buttons) {
        const t = (b.textContent || "").trim().toLowerCase();
        if (
          t === "accept" ||
          t === "accept all" ||
          t === "agree" ||
          t === "ok" ||
          t === "got it"
        ) {
          try {
            b.click();
          } catch {}
        }
      }
    })
    .catch(() => {});
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
  await dismissOverlays(page);
}

async function newChat(page: Page): Promise<void> {
  await dismissOverlays(page);
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

  // Dispatch directly — overlay-proof.
  await button.evaluate((el) => {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
    );
  }).catch(() => {});
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

async function readAnswerState(page: Page): Promise<{
  count: number;
  lastText: string;
  lastNonEmpty: string;
}> {
  const timeout = new Promise<{
    count: number;
    lastText: string;
    lastNonEmpty: string;
  }>((resolve) =>
    setTimeout(() => resolve({ count: -1, lastText: "", lastNonEmpty: "" }), 8000),
  );

  const probe = page
    .evaluate((sel) => {
      const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      const lastEl = els[els.length - 1];
      const lastText = lastEl ? lastEl.textContent || "" : "";

      let lastNonEmpty = "";
      for (let i = els.length - 1; i >= 0; i--) {
        const t = els[i].textContent || "";
        if (t.trim().length > 0) {
          lastNonEmpty = t;
          break;
        }
      }
      return { count: els.length, lastText, lastNonEmpty };
    }, answerSelector)
    .catch(() => ({ count: -1, lastText: "", lastNonEmpty: "" }));

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

async function tagCurrentAnswer(page: Page): Promise<void> {
  await page
    .evaluate(
      ([sel, attr]) => {
        document
          .querySelectorAll(`[${attr}]`)
          .forEach((el) => el.removeAttribute(attr));

        const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
        const last = els[els.length - 1];
        if (last) last.setAttribute(attr, "1");
      },
      [answerSelector, answerTargetAttr] as const,
    )
    .catch(() => {});
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  await dismissOverlays(page);
  await scrollToBottom(page);
  await page.waitForTimeout(500);

  const base = await readAnswerState(page);
  answerBaselineCount = base.count === -1 ? 0 : base.count;
  answerBaselineText = base.count === -1 ? "" : base.lastNonEmpty;

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
      // Dispatch directly — overlay-proof.
      await sendBtn
        .evaluate((el) => {
          el.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
            }),
          );
        })
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

async function waitForCompletion(
  page: Page,
  stableMs = 3000,
  timeoutMs = 5 * 60_000,
): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  const countDeadline = start + 10_000;

  await scrollToBottom(page);

  let scrollTick = 0;
  let lastHeartbeat = Date.now();

  while (Date.now() < deadline) {
    if (scrollTick++ % 6 === 0) await scrollToBottom(page);

    const state = await readAnswerState(page);
    if (state.count === -1) {
      await page.waitForTimeout(500);
      continue;
    }

    if (state.count > answerBaselineCount) break;

    if (Date.now() > countDeadline) {
      if (
        state.lastNonEmpty.length > 0 &&
        answerBaselineText.length > 0 &&
        state.lastNonEmpty !== answerBaselineText
      ) {
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

  if (Date.now() >= deadline) {
    throw new Error(
      `No new answer appeared within ${Math.round(timeoutMs / 1000)}s.`,
    );
  }

  let prevText = "";
  let stableSince = Date.now();
  scrollTick = 0;
  let streaming = false;

  while (Date.now() < deadline) {
    if (scrollTick++ % 6 === 0) await scrollToBottom(page);

    const state = await readAnswerState(page);
    if (state.count === -1) {
      await page.waitForTimeout(500);
      continue;
    }

    const text = state.lastText;

    if (text.length === 0) {
      streaming = false;
      prevText = "";
      stableSince = Date.now();
    } else if (text === prevText) {
      if (Date.now() - stableSince >= stableMs) {
        await tagCurrentAnswer(page);
        return;
      }
    } else {
      streaming = true;
      prevText = text;
      stableSince = Date.now();
    }

    if (Date.now() - lastHeartbeat > 15_000) {
      const secs = Math.round((Date.now() - start) / 1000);
      console.log(
        streaming
          ? `   … answer streaming (${secs}s)`
          : `   … waiting for response (${secs}s)`,
      );
      lastHeartbeat = Date.now();
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `No new answer appeared within ${Math.round(timeoutMs / 1000)}s.`,
  );
}

async function tagAnswerCopyButton(page: Page): Promise<Locator | null> {
  const marker = `cli-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const tagOnce = async (): Promise<boolean> => {
    return await page
      .evaluate(
        ([ansSel, attr, prefix, mk]) => {
          let target =
            (document.querySelector(`[${attr}]`) as HTMLElement | null) ??
            null;

          if (!target) {
            const answers = Array.from(
              document.querySelectorAll(ansSel),
            ) as HTMLElement[];
            target = answers[answers.length - 1] ?? null;
          }
          if (!target) return false;

          const buttons = Array.from(
            document.querySelectorAll('div[role="button"], [role="button"]'),
          ) as HTMLElement[];

          for (const el of buttons) {
            if (el.closest(".md-code-block-banner")) continue;
            if (el.closest(ansSel)) continue;
            const path = el.querySelector("svg path");
            const d = path?.getAttribute("d") ?? "";
            if (!d.startsWith(prefix)) continue;

            const pos = target.compareDocumentPosition(el);
            const isAfter = !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
            const targetRow = target.closest(
              ".ds-message, [data-virtual-list-item-key]",
            );
            const elRow = el.closest(
              ".ds-message, [data-virtual-list-item-key]",
            );
            const sameRow = targetRow !== null && targetRow === elRow;

            if (!isAfter && !sameRow) continue;

            el.setAttribute("data-cli-copy-target", mk);
            return true;
          }
          return false;
        },
        [answerSelector, answerTargetAttr, copyIconPathPrefix, marker] as const,
      )
      .catch(() => false);
  };

  if (await tagOnce()) {
    return page.locator(`[data-cli-copy-target="${marker}"]`).first();
  }

  const tagged = page.locator(`[${answerTargetAttr}]`).first();
  const hoverTarget =
    (await tagged.count()) > 0 ? tagged : page.locator(answerSelector).last();

  await hoverTarget.scrollIntoViewIfNeeded().catch(() => {});
  await hoverTarget.hover({ force: true }).catch(() => {});
  await page.waitForTimeout(700);

  if (await tagOnce()) {
    return page.locator(`[data-cli-copy-target="${marker}"]`).first();
  }

  await scrollToBottom(page);
  await hoverTarget.hover({ force: true }).catch(() => {});
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

  // Dispatch a synthetic click directly on the element. Coordinate-based
  // clicks hit whatever is on top — Replit's cookie banner was swallowing
  // them. dispatchEvent bypasses hit-testing entirely.
  await button
    .evaluate((el) => {
      el.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    })
    .catch(() => {});

  await page.waitForTimeout(800);

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

async function readMarkdownFromDom(page: Page): Promise<string> {
  await scrollToBottom(page);

  const tagged = page.locator(`[${answerTargetAttr}]`).first();
  const container =
    (await tagged.count()) > 0 ? tagged : page.locator(answerSelector).last();

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