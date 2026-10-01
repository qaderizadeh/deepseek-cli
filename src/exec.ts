import { spawn } from "node:child_process";

export type CodeBlock = { lang: string; code: string };

export type ExecResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
};

/**
 * Parse all fenced code blocks. The language is everything before the first
 * whitespace on the fence line, normalized to lower case and stripped of
 * `{.…}` or surrounding backticks. Handles "```text", "``` text",
 * "```TEXT title", "```{.text}", etc.
 */
export function parseBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const re = /```([^\n]*)\n([\s\S]*?)\n?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const info = (m[1] ?? "").trim();
    const first = info.split(/\s+/)[0] ?? "";
    const lang = first.replace(/^[{.`]+|`+$/g, "").toLowerCase();
    blocks.push({ lang, code: m[2].replace(/\n+$/, "") });
  }
  return blocks;
}

export function firstBlock(
  markdown: string,
  skipLangs: Set<string> = new Set(),
): CodeBlock | null {
  for (const b of parseBlocks(markdown)) {
    if (skipLangs.has(b.lang)) continue;
    return b;
  }
  return null;
}

export function runShell(
  command: string,
  timeoutMs = 60_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: process.cwd(),
      detached: true,
    });

    let output = "";
    let timedOut = false;
    let resolved = false;

    const finish = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      const trimmed = output.trimEnd();
      const parts = [`$ ${command}`, "", trimmed || "(no output)"];
      if (timedOut) {
        parts.push("");
        parts.push(`[timed out after ${Math.round(timeoutMs / 1000)}s]`);
      }
      parts.push("");
      parts.push(`(exit ${code ?? "?"})`);
      resolve({ output: parts.join("\n"), exitCode: code, timedOut });
    };

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already dead */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");

      setTimeout(() => {
        killGroup("SIGKILL");
        setTimeout(() => finish(null), 500);
      }, 2000);
    }, timeoutMs);

    child.stdout?.on("data", (d) => (output += d.toString()));
    child.stderr?.on("data", (d) => (output += d.toString()));

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      output += `\n${String(err)}`;
      finish(-1);
    });
  });
}