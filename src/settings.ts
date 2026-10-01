export type Settings = {
  deepThink: boolean;
  search: boolean;
  timeoutMs: number;
};

const DEFAULTS: Settings = {
  deepThink: true,
  search: false,
  timeoutMs: 60_000,
};

export function parseSettings(argv: string[]): Settings {
  const settings = { ...DEFAULTS };

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
  return `DeepThink: ${on(settings.deepThink)} | Search: ${on(
    settings.search,
  )} | Exec timeout: ${secs}s`;
}