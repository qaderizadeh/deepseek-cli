export type Settings = {
  deepThink: boolean;
  search: boolean;
};

const DEFAULTS: Settings = {
  deepThink: true,
  search: false,
};

export function parseSettings(argv: string[]): Settings {
  const settings = { ...DEFAULTS };

  for (const arg of argv) {
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
  return `DeepThink: ${on(settings.deepThink)} | Search: ${on(settings.search)}`;
}