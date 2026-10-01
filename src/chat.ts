import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Chat } from "./sites.js";

export type Selection = { kind: "new" } | { kind: "existing"; chat: Chat };

export async function selectChat(chats: Chat[]): Promise<Selection> {
  const rl = createInterface({ input: stdin, output: stdout });

  console.log("\nChats:");
  console.log("  0) + New chat");
  chats.forEach((chat, i) => console.log(`  ${i + 1}) ${chat.title}`));

  const answer = (await rl.question("\nSelect: ")).trim();
  rl.close();

  const n = Number(answer);

  if (n === 0) return { kind: "new" };
  if (Number.isInteger(n) && n >= 1 && n <= chats.length) {
    return { kind: "existing", chat: chats[n - 1] };
  }
  throw new Error(`Invalid selection: "${answer}"`);
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

export async function runRepl(
  handler: (line: string) => Promise<void>,
): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const line = (await rl.question("\n> ")).trim();

      if (["exit", "quit", "q"].includes(line.toLowerCase())) return;
      if (!line) continue;

      try {
        await handler(line);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\nError: ${msg}`);
      }
    }
  } finally {
    rl.close();
  }
}