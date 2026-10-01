import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
  type BrowserContext,
} from "playwright";
import { mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";

type Candidate = {
  label: string;
  type: BrowserType;
  // Playwright channel name (chrome, msedge, ...). When set, we call
  // launch({ channel }) instead of executablePath.
  channel?: string;
  // Explicit binary path. Used when the browser is not on a Playwright
  // channel but exists on the system (Brave, Chromium, Vivaldi, ...).
  path?: string;
};

// 1) Playwright channels — these are the officially supported names.
const CHANNEL_CANDIDATES: Candidate[] = [
  { label: "chrome", type: chromium, channel: "chrome" },
  { label: "chrome-beta", type: chromium, channel: "chrome-beta" },
  { label: "chrome-dev", type: chromium, channel: "chrome-dev" },
  { label: "chrome-canary", type: chromium, channel: "chrome-canary" },
  { label: "msedge", type: chromium, channel: "msedge" },
  { label: "msedge-beta", type: chromium, channel: "msedge-beta" },
  { label: "msedge-dev", type: chromium, channel: "msedge-dev" },
  { label: "msedge-canary", type: chromium, channel: "msedge-canary" },
  { label: "firefox", type: firefox, channel: "firefox" },
  { label: "webkit", type: webkit, channel: "webkit" },
];

// 2) Well-known binaries we can find on PATH. Order matters — user's
// preferred browser first.
const PATH_BINARIES: Array<{ label: string; type: BrowserType; bin: string }> = [
  { label: "brave", type: chromium, bin: "brave-browser" },
  { label: "brave", type: chromium, bin: "brave" },
  { label: "chromium", type: chromium, bin: "chromium" },
  { label: "chromium", type: chromium, bin: "chromium-browser" },
  { label: "google-chrome", type: chromium, bin: "google-chrome" },
  { label: "google-chrome-stable", type: chromium, bin: "google-chrome-stable" },
  { label: "microsoft-edge", type: chromium, bin: "microsoft-edge" },
  { label: "microsoft-edge-stable", type: chromium, bin: "microsoft-edge-stable" },
  { label: "vivaldi", type: chromium, bin: "vivaldi" },
  { label: "opera", type: chromium, bin: "opera" },
  { label: "firefox", type: firefox, bin: "firefox" },
];

type LaunchOptions = {
  profileDir: string;
  headless?: boolean;
};

function which(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function tryLaunch(candidate: Candidate): Promise<boolean> {
  try {
    const browser = candidate.channel
      ? await candidate.type.launch({ channel: candidate.channel })
      : await candidate.type.launch({ executablePath: candidate.path });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

async function detectBrowser(): Promise<Candidate> {
  // Channels first.
  for (const c of CHANNEL_CANDIDATES) {
    if (await tryLaunch(c)) return c;
  }

  // Then PATH binaries.
  for (const b of PATH_BINARIES) {
    const resolved = which(b.bin);
    if (!resolved) continue;
    if (!(await exists(resolved))) continue;
    const candidate: Candidate = {
      label: `${b.label} (${resolved})`,
      type: b.type,
      path: resolved,
    };
    if (await tryLaunch(candidate)) return candidate;
  }

  throw new Error(
    "No usable browser found. Install one of: Chrome, Chromium, Brave, " +
      "Edge, Vivaldi, Opera, or Firefox.",
  );
}

async function installClipboardCapture(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    (window as any).__copiedText = "";

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
  const candidate = await detectBrowser();
  console.log(`Using system browser: ${candidate.label}`);

  await mkdir(profileDir, { recursive: true });

  const common = { headless };
  const context = candidate.channel
    ? await candidate.type.launchPersistentContext(profileDir, {
        ...common,
        channel: candidate.channel,
      })
    : await candidate.type.launchPersistentContext(profileDir, {
        ...common,
        executablePath: candidate.path,
      });

  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "https://chat.deepseek.com",
    });
  } catch {
    // Firefox may reject; the init script covers that path.
  }

  await installClipboardCapture(context);
  return context;
}