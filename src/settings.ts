export type Settings = {
  deepThink: boolean;
  search: boolean;
  timeoutMs: number;
  skipLangs: string[];
};

// "" means unlabeled fences (```` ``` ```` with no language) are skipped too.
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
      case "--skip": {
        const value = argv[++i];
        if (value === undefined) {
          throw new Error("--skip requires a language value");
        }
        settings.skipLangs.push(value.toLowerCase());
        break;
      }
      case "--no-skip":
        // Clear the defaults entirely — allows constructing a fresh list
        // by following this with --skip entries.
        settings.skipLangs = [];
        break;
      case "--run-empty":
        // Explicitly allow running unlabeled fences.
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
    `Skip: ${skip}`
  );
}