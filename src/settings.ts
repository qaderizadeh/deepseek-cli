export type Settings = {
  deepThink: boolean;
  search: boolean;
  timeoutMs: number;
  skipLangs: string[];
  browser: string | null;
};

const DEFAULT_SKIP_LANGS = [
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "json",
  "output",
  "none",
  "markdown",
  "md",
];

const DEFAULTS: Settings = {
  deepThink: true,
  search: false,
  timeoutMs: 60_000,
  skipLangs: [...DEFAULT_SKIP_LANGS],
  browser: null,
};

export function parseSettings(argv: string[]): Settings {
  const settings: Settings = {
    ...DEFAULTS,
    skipLangs: [...DEFAULTS.skipLangs],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--deep-think":
        settings.deepThink = true;
        break;
      case "--no-deep-think":
        settings.deepThink = false;
        break;
      case "--search":
        settings.search = true;
        break;
      case "--no-search":
        settings.search = false;
        break;
      case "--timeout": {
        const value = argv[++i];
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error(`Invalid --timeout value: "${value}"`);
        }
        settings.timeoutMs = Math.round(seconds * 1000);
        break;
      }
      case "--browser": {
        const value = argv[++i];
        if (!value) throw new Error("--browser requires a name");
        settings.browser = value.toLowerCase();
        break;
      }
      case "--skip": {
        const value = argv[++i];
        if (value === undefined) {
          throw new Error("--skip requires a language value");
        }
        settings.skipLangs.push(value.toLowerCase());
        break;
      }
      case "--no-skip":
        settings.skipLangs = [];
        break;
      case "--run-empty":
        settings.skipLangs = settings.skipLangs.filter((l) => l !== "");
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }
  return settings;
}

export function describe(settings: Settings): string {
  const on = (v: boolean) => (v ? "on" : "off");
  const secs = Math.round(settings.timeoutMs / 1000);
  const skip = settings.skipLangs.length
    ? settings.skipLangs.map((l) => (l === "" ? "(unlabeled)" : l)).join(", ")
    : "(none)";
  return (
    `DeepThink: ${on(settings.deepThink)} | ` +
    `Search: ${on(settings.search)} | ` +
    `Exec timeout: ${secs}s | ` +
    `Browser: ${settings.browser ?? "auto"} | ` +
    `Skip: ${skip}`
  );
}