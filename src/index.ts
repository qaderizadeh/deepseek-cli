import { launchPersistent } from "./browser.js";
import { ensureLoggedIn } from "./auth.js";
import { deepseek } from "./sites.js";
import { selectChat, ask, runRepl } from "./chat.js";
import { parseSettings, describe } from "./settings.js";
import { firstBlock, runShell } from "./exec.js";
import type { Page } from "playwright";

const PROFILE_DIR = "./.profile";
const MAX_ROUNDS = 8;

async function repl(
  page: Page,
  timeoutMs: number,
  skipLangs: Set<string>,
): Promise<void> {
  console.log("");
  console.log("─".repeat(60));
  console.log("  Type your prompt and press Enter.");
  console.log("  Commands: /new (start fresh chat), exit (quit)");
  console.log("─".repeat(60));

  await runRepl(async (line) => {
    if (line === "/new") {
      await deepseek.newChat(page);
      console.log("Started a new chat.");
      return;
    }

    let prompt = line;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      await deepseek.sendPrompt(page, prompt);
      console.log("\n(thinking…)\n");

      const markdown = await deepseek.readAnswer(page);
      console.log("─".repeat(60));
      console.log(markdown.trimEnd());
      console.log("─".repeat(60));

      const block = firstBlock(markdown, skipLangs);
      if (!block) return;

      const lang = block.lang || "(unlabeled)";
      console.log(`\n▶ [${lang}] $ ${block.code}\n`);
      const result = await runShell(block.code, timeoutMs);
      console.log(result.output);

      prompt = result.output;
    }
  });

  console.log("\nBye.");
}

async function main(): Promise<void> {
  const settings = parseSettings(process.argv.slice(2));
  console.log(describe(settings));

  const context = await launchPersistent({ profileDir: PROFILE_DIR });

  try {
    const page = await ensureLoggedIn(context, {
      url: deepseek.url,
      isLoggedIn: deepseek.isLoggedIn,
    });

    const chats = await deepseek.listChats(page);
    console.log(`Found ${chats.length} chat(s).`);

    const selection = await selectChat(chats);

    if (selection.kind === "new") {
      await deepseek.newChat(page);
      console.log("Started a new chat.");
    } else {
      await deepseek.openChat(page, selection.chat);
      console.log(`Opened: ${selection.chat.title}`);
    }

    await page.waitForSelector("textarea, [contenteditable='true']", {
      timeout: 10_000,
    });

    console.log("Applying settings...");
    const applied = await deepseek.applySettings(page, settings);

    if (!applied) {
      await ask(
        "\nPlease set DeepThink/Search manually in the browser, then press Enter...",
      );
    }

    await repl(page, settings.timeoutMs, new Set(settings.skipLangs));
  } finally {
    await context.close();
  }
}

await main();