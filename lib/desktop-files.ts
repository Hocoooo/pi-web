import { execFile } from "node:child_process";
import path from "node:path";
import { windowsRevealFallbackScript, windowsRevealInTabScript } from "./windows-explorer";

declare global {
  var __piDesktopRevealQueue: Promise<void> | undefined;
}

export type DesktopFileAction = "open" | "reveal";

/** Paths are data, never shell source. Windows ShellExecute honors file associations. */
export function desktopFileCommand(filePath: string, action: DesktopFileAction, platform = process.platform) {
  if (platform === "win32") {
    const script = action === "open"
      ? "$ErrorActionPreference='Stop'; $p=New-Object System.Diagnostics.ProcessStartInfo; $p.FileName=$env:PI_WEB_DESKTOP_FILE; $p.UseShellExecute=$true; [System.Diagnostics.Process]::Start($p) | Out-Null"
      : windowsRevealInTabScript;
    return {
      command: path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    };
  }
  if (platform === "darwin") return { command: "/usr/bin/open", args: action === "reveal" ? ["-R", filePath] : [filePath] };
  if (platform === "linux") return { command: "xdg-open", args: [action === "reveal" ? path.dirname(filePath) : filePath] };
  throw new Error("Desktop file actions are not supported on this platform");
}

async function executeDesktopCommand(filePath: string, command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, {
      env: { ...process.env, PI_WEB_DESKTOP_FILE: filePath },
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    }, (error) => error ? reject(new Error("The system could not open this file. Check its default application and desktop availability.")) : resolve());
  });
}

export async function launchDesktopFile(filePath: string, action: DesktopFileAction): Promise<void> {
  const { command, args } = desktopFileCommand(filePath, action);
  if (process.platform !== "win32" || action !== "reveal") {
    return executeDesktopCommand(filePath, command, args);
  }
  // Serialize reveals across links/sessions: overlapping tab snapshots are ambiguous.
  const run = (globalThis.__piDesktopRevealQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
    try {
      await executeDesktopCommand(filePath, command, args);
    } catch {
      // The script has its own fallback, but a blocked UIA/COM call may hit the
      // process timeout before it can run. Retry without automation in that case.
      await executeDesktopCommand(filePath, command, [
        "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
        Buffer.from(windowsRevealFallbackScript, "utf16le").toString("base64"),
      ]);
    }
  });
  const settled = run.catch(() => {});
  globalThis.__piDesktopRevealQueue = settled;
  try { await run; } finally {
    if (globalThis.__piDesktopRevealQueue === settled) globalThis.__piDesktopRevealQueue = undefined;
  }
}

/** This desktop-only endpoint deliberately excludes LAN/relay access. */
export function isLocalDesktopRequest(request: Request): boolean {
  try {
    const host = request.headers.get("host");
    const origin = request.headers.get("origin");
    if (!host || !origin) return false;
    const target = new URL(`${new URL(request.url).protocol}//${host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) return false;
    return new URL(origin).origin === target.origin
      && !["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")
      // Next.js itself supplies this header even without an external proxy.
      && (!request.headers.has("x-forwarded-host") || request.headers.get("x-forwarded-host") === host);
  } catch {
    return false;
  }
}
