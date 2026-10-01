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
  channel?: string;
  path?: string;
};

// Aliases so users can type the friendly name.
const ALIASES: Record<string, string> = {
  chrome: "chrome",
  google: "chrome",
  "google-chrome": "chrome",
  edge: "msedge",
  "ms-edge": "msedge",
  microsoft: "msedge",
  brave: "brave",
  chromium: "chromium",
  vivaldi: "vivaldi",
  opera: "opera",
  firefox: "firefox",
  ff: "firefox",
  webkit: "webkit",
  safari: "webkit",
};

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

const PATH_BINARIES: Array<{ name: string; type: BrowserType; bins: string[] }> = [
  { name: "brave", type: chromium, bins: ["brave-browser", "brave"] },
  { name: "chromium", type: chromium, bins: ["chromium", "chromium-browser"] },
  { name: "chrome", type: chromium, bins: ["google-chrome", "google-chrome-stable"] },
  { name: "msedge", type: chromium, bins: ["microsoft-edge", "microsoft-edge-stable"] },
  { name: "vivaldi", type: chromium, bins: ["vivaldi", "vivaldi-stable"] },
  { name: "opera", type: chromium, bins: ["opera"] },
  { name: "firefox", type: firefox, bins: ["firefox"] },
];

type LaunchOptions = {
  profileDir: string;
  headless?: boolean;
  // Requested browser name (from --browser). null = auto-detect.
  preferred?: string | null;
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

async function detectAll(): Promise<Candidate[]> {
  const found: Candidate[] = [];

  for (const c of CHANNEL_CANDIDATES) {
    if (await tryLaunch(c)) found.push(c);
  }

  for (const b of PATH_BINARIES) {
    for (const bin of b.bins) {
      const resolved = which(bin);
      if (!resolved) continue;
      if (!(await exists(resolved))) continue;
      const candidate: Candidate = {
        label: `${b.name} (${resolved})`,
        type: b.type,
        path: resolved,
      };
      if (await tryLaunch(candidate)) {
        found.push(candidate);
        break; // one binary per family
      }
    }
  }

  return found;
}

async function pickBrowser(preferred?: string | null): Promise<Candidate> {
  const all = await detectAll();

  if (!preferred) {
    if (all.length === 0) {
      throw new Error(
        "No usable browser found. Install one of: Chrome, Chromium, Brave, " +
          "Edge, Vivaldi, Opera, or Firefox.",
      );
    }
    return all[0];
  }

  const wanted = ALIASES[preferred] ?? preferred;

  const match = all.find(
    (c) => c.label === wanted || c.label.startsWith(wanted + " "),
  );
  if (match) return match;

  throw new Error(
    `Browser "${preferred}" not found. Available: ${all
      .map((c) => c.label)
      .join(", ")}`,
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
  preferred = null,
}: LaunchOptions): Promise<BrowserContext> {
  const candidate = await pickBrowser(preferred);
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