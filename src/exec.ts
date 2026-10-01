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
    // detached: true puts the child in its own process group so we can
    // kill the whole tree (shell + grandchildren) at once.
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
        // Negative PID = kill the entire process group.
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

      // After grace period, force-kill the group and resolve regardless.
      // Needed because an orphaned grandchild can keep stdio open, so
      // 'close' may never fire.
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