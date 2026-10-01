import { spawn } from "node:child_process";

export type CodeBlock = { lang: string; code: string };

export type ExecResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
};

export function firstBlock(markdown: string): CodeBlock | null {
  const re = /```([\w-]*)[^\n]*\n([\s\S]*?)```/;
  const m = markdown.match(re);
  if (!m) return null;
  return {
    lang: (m[1] || "").toLowerCase(),
    code: m[2].replace(/\n+$/, "").trim(),
  };
}

export function runShell(
  command: string,
  timeoutMs = 60_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd: process.cwd() });
    let output = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give it 2 s to die gracefully, then force-kill.
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutMs);

    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));

    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = output.trimEnd();
      const parts = [
        `$ ${command}`,
        "",
        trimmed || "(no output)",
      ];
      if (timedOut) {
        parts.push("");
        parts.push(`[timed out after ${Math.round(timeoutMs / 1000)}s]`);
      }
      parts.push("");
      parts.push(`(exit ${code ?? "?"})`);
      resolve({ output: parts.join("\n"), exitCode: code, timedOut });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        output: `$ ${command}\n\n${String(err)}\n\n(exit ?)`,
        exitCode: -1,
        timedOut,
      });
    });
  });
}