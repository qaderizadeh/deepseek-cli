import { chromium, firefox, webkit, type BrowserType, type BrowserContext } from "playwright";
import { mkdir } from "node:fs/promises";

type Candidate = { name: string; type: BrowserType };

const candidates: Candidate[] = [
  { name: "chrome", type: chromium },
  { name: "msedge", type: chromium },
  { name: "firefox", type: firefox },
  { name: "webkit", type: webkit },
];

type LaunchOptions = {
  profileDir: string;
  headless?: boolean;
};

async function detectBrowser(): Promise<Candidate> {
  for (const candidate of candidates) {
    try {
      const browser = await candidate.type.launch({ channel: candidate.name });
      await browser.close();
      return candidate;
    } catch {
      // not installed — try next
    }
  }
  throw new Error("No system browser found. Install Chrome, Edge, or Firefox.");
}

async function installClipboardCapture(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    (window as any).__copiedText = "";

    // Modern async clipboard API — hook writeText.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      try {
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: async (text: string) => {
            (window as any).__copiedText = text;
            try {
              return await original(text);
            } catch {
              return;
            }
          },
        });
      } catch {
        // Firefox may freeze the property; skip.
      }
    }

    // Legacy fallback.
    const originalExec = document.execCommand.bind(document);
    (document as any).execCommand = function (cmd: string, ...rest: any[]) {
      if (cmd === "copy") {
        const sel = window.getSelection();
        if (sel) (window as any).__copiedText = sel.toString();
      }
      return originalExec(cmd, ...rest);
    };
  });
}

export async function launchPersistent({
  profileDir,
  headless = false,
}: LaunchOptions): Promise<BrowserContext> {
  const { name, type } = await detectBrowser();
  console.log(`Using system browser: ${name}`);

  await mkdir(profileDir, { recursive: true });

  const context = await type.launchPersistentContext(profileDir, {
    channel: name,
    headless,
  });

  // Best-effort. Firefox may reject; the init script covers that path.
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "https://chat.deepseek.com",
    });
  } catch {
    // ignore
  }

  await installClipboardCapture(context);
  return context;
}