import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, readFile, stat, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { Tool, ToolContext } from "../Tool.js";

const execFile = promisify(execFileCallback);
const MAX_TYPE_LENGTH = 500;
const MAX_SCREENSHOT_DATA_URL_BYTES = 4 * 1024 * 1024;

type ExecResult = { stdout: string; stderr: string };

const emptySchema = z.object({});

export const desktopScreenInfoTool: Tool<Record<string, never>, unknown> = {
  name: "desktop_get_screen_info",
  description: "Get host desktop screen information, cursor position when available, and visible window titles.",
  inputSchema: emptySchema,
  parametersJsonSchema: { type: "object", properties: {} },
  risk: "exec",
  isEnabled: () => true,
  async run(): Promise<unknown> {
    return {
      platform: process.platform,
      screen: await getScreenBounds().catch((error) => ({ error: errorMessage(error) })),
      cursor: await getCursorPosition().catch(() => null),
      windows: await listWindows().catch((error) => ({ error: errorMessage(error) })),
    };
  },
};

const captureSchema = z.object({
  format: z.enum(["png", "jpg"]).optional(),
});

export const desktopCaptureScreenTool: Tool<z.infer<typeof captureSchema>, unknown> = {
  name: "desktop_capture_screen",
  description: "Capture a host desktop screenshot. Use ONLY when the user explicitly asks for a screenshot, or right before a mouse click that requires knowing exact on-screen coordinates.",
  inputSchema: captureSchema,
  parametersJsonSchema: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["png", "jpg"], description: "Screenshot format." },
    },
  },
  risk: "exec",
  isEnabled: () => true,
  async run(input, context: ToolContext): Promise<unknown> {
    const format = input.format ?? defaultScreenshotFormat();
    const dir = path.join(context.cwd, ".neros", "screenshots");
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `desktop-${Date.now()}.${format}`);
    await captureScreen(filePath, format);
    await optimizeScreenshot(filePath, format);

    const info = await stat(filePath);
    const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
    const result: Record<string, unknown> = {
      path: path.relative(context.cwd, filePath).replaceAll(path.sep, "/"),
      absolutePath: filePath,
      mimeType,
      size: info.size,
    };
    if (info.size <= MAX_SCREENSHOT_DATA_URL_BYTES) {
      result.imageDataUrl = `data:${mimeType};base64,${(await readFile(filePath)).toString("base64")}`;
    }
    return result;
  },
};

const mouseSchema = z.object({
  action: z.enum(["move", "click", "double_click", "right_click", "drag", "scroll"]),
  x: z.number().optional(),
  y: z.number().optional(),
  toX: z.number().optional(),
  toY: z.number().optional(),
  amount: z.number().optional(),
});

export const desktopMouseTool: Tool<z.infer<typeof mouseSchema>, unknown> = {
  name: "desktop_mouse",
  description: "Control the host mouse: move, click, double_click, right_click, drag, or scroll.",
  inputSchema: mouseSchema,
  parametersJsonSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["move", "click", "double_click", "right_click", "drag", "scroll"] },
      x: { type: "number" },
      y: { type: "number" },
      toX: { type: "number" },
      toY: { type: "number" },
      amount: { type: "number" },
    },
  },
  risk: "exec",
  isEnabled: () => true,
  async run(input): Promise<unknown> {
    await runMouseAction(input.action, input);
    return input;
  },
};

const keyboardSchema = z.object({
  action: z.enum(["type", "press", "hotkey", "diagnose"]),
  text: z.string().max(MAX_TYPE_LENGTH).optional(),
  key: z.string().optional(),
  keys: z.string().optional(),
  targetTitle: z.string().optional(),
  clickX: z.number().optional(),
  clickY: z.number().optional(),
  delayMs: z.number().optional(),
  method: z.enum(["auto", "paste", "keystroke"]).optional(),
});

export const desktopKeyboardTool: Tool<z.infer<typeof keyboardSchema>, unknown> = {
  name: "desktop_keyboard",
  description: "Send keyboard input to the active host window: type text, press a key, send a hotkey combo, or diagnose keyboard automation. Can focus a target window and click a target point before typing.",
  inputSchema: keyboardSchema,
  parametersJsonSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["type", "press", "hotkey", "diagnose"] },
      text: { type: "string", description: "Text to type. Maximum 500 characters." },
      key: { type: "string" },
      keys: { type: "string" },
      targetTitle: { type: "string", description: "Optional window/app title substring to focus before sending input." },
      clickX: { type: "number", description: "Optional x coordinate to click before sending input." },
      clickY: { type: "number", description: "Optional y coordinate to click before sending input." },
      delayMs: { type: "number", description: "Optional delay after focusing/clicking before sending input." },
      method: { type: "string", enum: ["auto", "paste", "keystroke"], description: "Typing method. macOS auto uses clipboard paste for Unicode." },
    },
  },
  risk: "exec",
  isEnabled: () => true,
  async run(input): Promise<unknown> {
    if (input.action === "diagnose") return diagnoseKeyboardAutomation();

    if (input.targetTitle) {
      await focusWindow(input.targetTitle);
      await sleep(Math.max(0, Math.floor(input.delayMs ?? 250)));
    }
    if (input.clickX !== undefined || input.clickY !== undefined) {
      requirePoint(input.clickX, input.clickY);
      await runMouseAction("click", {
        action: "click",
        x: input.clickX,
        y: input.clickY,
      });
      await sleep(Math.max(0, Math.floor(input.delayMs ?? 150)));
    } else if (input.delayMs !== undefined && !input.targetTitle) {
      await sleep(Math.max(0, Math.floor(input.delayMs)));
    }

    await runKeyboardAction(input.action, {
      text: input.text ?? "",
      key: input.key ?? "",
      keys: input.keys ?? "",
      method: input.method ?? "auto",
    });
    return {
      action: input.action,
      chars: input.action === "type" ? input.text?.length ?? 0 : undefined,
      key: input.key,
      keys: input.keys,
      targetTitle: input.targetTitle,
      clicked: input.clickX !== undefined && input.clickY !== undefined ? { x: input.clickX, y: input.clickY } : undefined,
      method: input.method ?? "auto",
    };
  },
};

const windowSchema = z.object({
  action: z.enum(["list", "focus"]),
  title: z.string().optional(),
});

export const desktopWindowTool: Tool<z.infer<typeof windowSchema>, unknown> = {
  name: "desktop_window",
  description: "List host windows or focus a window whose title/app name contains text.",
  inputSchema: windowSchema,
  parametersJsonSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "focus"] },
      title: { type: "string" },
    },
  },
  risk: "exec",
  isEnabled: () => true,
  async run(input): Promise<unknown> {
    if (input.action === "list") return listWindows();
    if (!input.title) throw new Error("title is required for focus");
    return focusWindow(input.title);
  },
};

const appLaunchSchema = z.object({
  target: z.string(),
  args: z.array(z.string()).optional(),
  waitMs: z.number().optional(),
});

export const appLaunchTool: Tool<z.infer<typeof appLaunchSchema>, unknown> = {
  name: "app_launch",
  description: "Launch a host application, file, directory, or URL.",
  inputSchema: appLaunchSchema,
  parametersJsonSchema: {
    type: "object",
    required: ["target"],
    properties: {
      target: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      waitMs: { type: "number" },
    },
  },
  risk: "exec",
  isEnabled: () => true,
  async run(input): Promise<unknown> {
    return launchTarget(input.target, input.args ?? [], input.waitMs ?? 1200);
  },
};

const browserOpenSchema = z.object({
  url: z.string(),
  browser: z.string().optional(),
});

export const browserOpenTool: Tool<z.infer<typeof browserOpenSchema>, unknown> = {
  name: "browser_open",
  description: "Open a URL in the host browser or a named browser application.",
  inputSchema: browserOpenSchema,
  parametersJsonSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      browser: { type: "string" },
    },
  },
  risk: "exec",
  isEnabled: () => true,
  async run(input): Promise<unknown> {
    return openUrl(normalizeUrl(input.url), input.browser);
  },
};

const browserSearchSchema = z.object({
  query: z.string(),
  engine: z.enum(["google", "bing", "baidu", "duckduckgo"]).optional(),
  browser: z.string().optional(),
});

export const browserSearchTool: Tool<z.infer<typeof browserSearchSchema>, unknown> = {
  name: "browser_search",
  description: "Search the web in the host browser using Google, Bing, Baidu, or DuckDuckGo.",
  inputSchema: browserSearchSchema,
  parametersJsonSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      engine: { type: "string", enum: ["google", "bing", "baidu", "duckduckgo"] },
      browser: { type: "string" },
    },
  },
  risk: "exec",
  isEnabled: () => true,
  async run(input): Promise<unknown> {
    return openUrl(searchUrl(input.query, input.engine ?? "google"), input.browser);
  },
};

async function getScreenBounds(): Promise<unknown> {
  if (process.platform === "darwin") {
    const { stdout } = await run("osascript", ["-e", 'tell application "Finder" to get bounds of window of desktop']);
    const [left, top, right, bottom] = parseFourNumbers(stdout);
    return { left, top, width: right - left, height: bottom - top };
  }
  if (process.platform === "win32") {
    const script = '[System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($s.Left),$($s.Top),$($s.Width),$($s.Height)"';
    const { stdout } = await runPowerShell(script);
    const [left, top, width, height] = parseFourNumbers(stdout);
    return { left, top, width, height };
  }
  const { stdout } = await run("sh", ["-lc", "xdpyinfo | awk '/dimensions:/ {print $2; exit}'"]);
  const [width, height] = parseTwoNumbers(stdout, /x/);
  return { left: 0, top: 0, width, height };
}

async function getCursorPosition(): Promise<{ x: number; y: number }> {
  if (process.platform === "darwin") {
    const script = [
      "from Quartz import CGEventCreate, CGEventGetLocation",
      "loc = CGEventGetLocation(CGEventCreate(None))",
      'print(f"{int(loc.x)},{int(loc.y)}")',
    ].join("\n");
    const { stdout } = await run("python3", ["-c", script]);
    const [x, y] = parseTwoNumbers(stdout);
    return { x, y };
  }
  if (process.platform === "win32") {
    const script = '[System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"';
    const { stdout } = await runPowerShell(script);
    const [x, y] = parseTwoNumbers(stdout);
    return { x, y };
  }
  const { stdout } = await run("sh", ["-lc", "xdotool getmouselocation --shell | awk -F= '/^[XY]=/ {print $2}' | paste -sd, -"]);
  const [x, y] = parseTwoNumbers(stdout);
  return { x, y };
}

let _nativeScreenshotPath: string | null | undefined;

async function findNativeScreenshot(): Promise<string | null> {
  if (_nativeScreenshotPath !== undefined) return _nativeScreenshotPath;

  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "native", "neros-screenshot", "dist", "NeroScreenshot.app", "Contents", "MacOS", "neros-screenshot"),
    path.resolve(process.cwd(), "native", "neros-screenshot", "dist", "NeroScreenshot.app", "Contents", "MacOS", "neros-screenshot"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      _nativeScreenshotPath = candidate;
      return candidate;
    } catch {
      // not found, try next
    }
  }

  _nativeScreenshotPath = null;
  return null;
}

async function captureScreen(filePath: string, format: "png" | "jpg"): Promise<void> {
  if (process.platform === "darwin") {
    const nativeBin = await findNativeScreenshot();
    if (nativeBin) {
      try {
        await run(nativeBin, ["--format", format, "--output", filePath, "--max-width", "1280", "--quality", "0.65"]);
        return;
      } catch (err) {
        const msg = errorMessage(err);
        if (msg.includes("TCC")) {
          throw new Error(
            `macOS 截屏失败：需要屏幕录制权限。\n\n` +
            `请到 系统设置 → 隐私与安全性 → 屏幕录制，找到 "NeroScreenshot" 并开启。\n` +
            `首次添加后需要重启 Neros dev server。`,
          );
        }
      }
    }
    try {
      await run("screencapture", ["-x", "-t", format, filePath]);
    } catch (err) {
      throw new Error(
        `macOS 截屏失败: ${errorMessage(err)}.\n\n` +
        `方案一（推荐）：运行 native/neros-screenshot/build.sh 构建原生截图工具，然后在系统设置中授权 NeroScreenshot。\n` +
        `方案二：到 系统设置 → 隐私与安全性 → 屏幕录制，给启动 Neros 的终端应用授权，然后完全退出重启。`,
      );
    }
    return;
  }
  if (process.platform === "win32") {
    const imageFormat = format === "jpg" ? "Jpeg" : "Png";
    const escapedPath = filePath.replaceAll("'", "''");
    await runPowerShell(`
      Add-Type -AssemblyName System.Windows.Forms;
      Add-Type -AssemblyName System.Drawing;
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
      $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
      $graphics = [System.Drawing.Graphics]::FromImage($bmp);
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
      $bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::${imageFormat});
      $graphics.Dispose();
      $bmp.Dispose();
    `);
    return;
  }
  await run("sh", ["-lc", 'gnome-screenshot -f "$1" || spectacle -b -o "$1" || import -window root "$1"', "sh", filePath]);
}

async function optimizeScreenshot(filePath: string, format: "png" | "jpg"): Promise<void> {
  if (format !== "jpg") return;
  if (process.platform === "darwin") {
    await run("sips", ["-Z", "1280", "-s", "format", "jpeg", "-s", "formatOptions", "65", filePath, "--out", filePath]).catch(() => undefined);
    return;
  }
  if (process.platform === "linux") {
    await run("sh", [
      "-lc",
      'if command -v magick >/dev/null 2>&1; then magick "$1" -resize 1280x1280\\> -quality 65 "$1"; elif command -v convert >/dev/null 2>&1; then convert "$1" -resize 1280x1280\\> -quality 65 "$1"; fi',
      "sh",
      filePath,
    ]).catch(() => undefined);
  }
}

async function runMouseAction(action: string, input: z.infer<typeof mouseSchema>): Promise<void> {
  if (process.platform === "darwin") return runMacMouseAction(action, input);
  if (process.platform === "win32") return runWindowsMouseAction(action, input);
  return runLinuxMouseAction(action, input);
}

async function runMacMouseAction(action: string, input: z.infer<typeof mouseSchema>): Promise<void> {
  if (action === "scroll") {
    await run("osascript", ["-e", `tell application "System Events" to scroll wheel ${Math.round(input.amount ?? 0)}`]);
    return;
  }
  requirePoint(input.x, input.y);
  if (action === "click") {
    await run("osascript", ["-e", `tell application "System Events" to click at {${input.x}, ${input.y}}`]);
    return;
  }
  await run("python3", ["-c", macQuartzMouseScript(action, input)]);
}

async function runWindowsMouseAction(action: string, input: z.infer<typeof mouseSchema>): Promise<void> {
  if (action !== "scroll") requirePoint(input.x, input.y);
  await runPowerShell(`
    Add-Type -AssemblyName System.Windows.Forms;
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class MouseNative {
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
      [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    }
"@;
    $LEFTDOWN=0x0002; $LEFTUP=0x0004; $RIGHTDOWN=0x0008; $RIGHTUP=0x0010; $WHEEL=0x0800;
    function LeftClick { [MouseNative]::mouse_event($LEFTDOWN,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [MouseNative]::mouse_event($LEFTUP,0,0,0,[UIntPtr]::Zero); }
    switch ('${action}') {
      'move' { [MouseNative]::SetCursorPos(${input.x ?? 0}, ${input.y ?? 0}) | Out-Null }
      'click' { [MouseNative]::SetCursorPos(${input.x ?? 0}, ${input.y ?? 0}) | Out-Null; LeftClick }
      'double_click' { [MouseNative]::SetCursorPos(${input.x ?? 0}, ${input.y ?? 0}) | Out-Null; LeftClick; Start-Sleep -Milliseconds 80; LeftClick }
      'right_click' { [MouseNative]::SetCursorPos(${input.x ?? 0}, ${input.y ?? 0}) | Out-Null; [MouseNative]::mouse_event($RIGHTDOWN,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [MouseNative]::mouse_event($RIGHTUP,0,0,0,[UIntPtr]::Zero) }
      'drag' { [MouseNative]::SetCursorPos(${input.x ?? 0}, ${input.y ?? 0}) | Out-Null; [MouseNative]::mouse_event($LEFTDOWN,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 120; [MouseNative]::SetCursorPos(${input.toX ?? input.x ?? 0}, ${input.toY ?? input.y ?? 0}) | Out-Null; Start-Sleep -Milliseconds 120; [MouseNative]::mouse_event($LEFTUP,0,0,0,[UIntPtr]::Zero) }
      'scroll' { [MouseNative]::mouse_event($WHEEL,0,0,${Math.round((input.amount ?? 0) * 120)},[UIntPtr]::Zero) }
    }
  `);
}

async function runLinuxMouseAction(action: string, input: z.infer<typeof mouseSchema>): Promise<void> {
  if (action === "scroll") {
    const button = (input.amount ?? 0) >= 0 ? "4" : "5";
    const count = Math.max(1, Math.abs(Math.round(input.amount ?? 0)));
    await run("xdotool", ["click", "--repeat", String(count), button]);
    return;
  }
  requirePoint(input.x, input.y);
  if (action === "move") await run("xdotool", ["mousemove", String(input.x), String(input.y)]);
  else if (action === "click") await run("xdotool", ["mousemove", String(input.x), String(input.y), "click", "1"]);
  else if (action === "double_click") await run("xdotool", ["mousemove", String(input.x), String(input.y), "click", "--repeat", "2", "1"]);
  else if (action === "right_click") await run("xdotool", ["mousemove", String(input.x), String(input.y), "click", "3"]);
  else if (action === "drag") {
    requirePoint(input.toX, input.toY);
    await run("xdotool", ["mousemove", String(input.x), String(input.y), "mousedown", "1", "mousemove", String(input.toX), String(input.toY), "mouseup", "1"]);
  }
}

function macQuartzMouseScript(action: string, input: z.infer<typeof mouseSchema>): string {
  const x = input.x ?? 0;
  const y = input.y ?? 0;
  const toX = input.toX ?? x;
  const toY = input.toY ?? y;
  return `
from Quartz import *
import time
x=${x}; y=${y}; to_x=${toX}; to_y=${toY}
def post(kind, pos, button=kCGMouseButtonLeft):
    CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(None, kind, pos, button))
def left_click():
    post(kCGEventLeftMouseDown, (x, y)); time.sleep(0.05); post(kCGEventLeftMouseUp, (x, y))
if "${action}" == "move":
    post(kCGEventMouseMoved, (x, y))
elif "${action}" == "double_click":
    left_click(); time.sleep(0.08); left_click()
elif "${action}" == "right_click":
    post(kCGEventRightMouseDown, (x, y), kCGMouseButtonRight); time.sleep(0.05); post(kCGEventRightMouseUp, (x, y), kCGMouseButtonRight)
elif "${action}" == "drag":
    post(kCGEventLeftMouseDown, (x, y)); time.sleep(0.12); post(kCGEventLeftMouseDragged, (to_x, to_y)); time.sleep(0.12); post(kCGEventLeftMouseUp, (to_x, to_y))
`;
}

async function runKeyboardAction(
  action: string,
  input: { text: string; key: string; keys: string; method?: "auto" | "paste" | "keystroke" },
): Promise<void> {
  if (process.platform === "darwin") return runMacKeyboardAction(action, input);
  if (process.platform === "win32") return runWindowsKeyboardAction(action, input);
  return runLinuxKeyboardAction(action, input);
}

async function runMacKeyboardAction(
  action: string,
  input: { text: string; key: string; keys: string; method?: "auto" | "paste" | "keystroke" },
): Promise<void> {
  if (action === "type") {
    if (!input.text) throw new Error("text is required");
    if (input.method === "keystroke") {
      await run("osascript", [
        "-e",
        "on run argv",
        "-e",
        'tell application "System Events" to keystroke (item 1 of argv)',
        "-e",
        "end run",
        input.text,
      ]);
      return;
    }
    await pasteTextWithClipboardRestore(input.text);
    return;
  }
  const combo = parseKeyCombo(action === "hotkey" ? input.keys : input.key);
  if (!combo.key) throw new Error(action === "hotkey" ? "keys is required" : "key is required");
  const keyCode = macKeyCode(combo.key);
  const using = macUsingClause(combo.modifiers);
  if (keyCode !== undefined) {
    await run("osascript", ["-e", `tell application "System Events" to key code ${keyCode}${using}`]);
    return;
  }
  await run("osascript", ["-e", `tell application "System Events" to keystroke "${escapeAppleScriptString(macKeyName(combo.key))}"${using}`]);
}

async function runWindowsKeyboardAction(action: string, input: { text: string; key: string; keys: string }): Promise<void> {
  const payload = action === "type" ? input.text : windowsSendKeys(action === "hotkey" ? input.keys : input.key);
  if (!payload) throw new Error(action === "hotkey" ? "keys is required" : "key/text is required");
  await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${payload.replaceAll("'", "''")}')`);
}

async function runLinuxKeyboardAction(action: string, input: { text: string; key: string; keys: string }): Promise<void> {
  if (action === "type") {
    if (!input.text) throw new Error("text is required");
    await run("xdotool", ["type", "--delay", "15", input.text]);
    return;
  }
  const keys = action === "hotkey" ? input.keys : input.key;
  if (!keys) throw new Error(action === "hotkey" ? "keys is required" : "key is required");
  await run("xdotool", ["key", keys]);
}

async function listWindows(): Promise<unknown> {
  if (process.platform === "darwin") {
    const script = `
      tell application "System Events"
        set out to {}
        repeat with proc in (application processes whose background only is false)
          set appName to name of proc
          repeat with win in windows of proc
            try
              set end of out to appName & " | " & name of win
            end try
          end repeat
        end repeat
        return out
      end tell
    `;
    const { stdout } = await run("osascript", ["-e", script]);
    return stdout.trim() ? stdout.trim().split(/,\s*/).slice(0, 50) : [];
  }
  if (process.platform === "win32") {
    const { stdout } = await runPowerShell("Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -First 50 ProcessName,MainWindowTitle | ConvertTo-Json -Compress");
    return JSON.parse(stdout || "[]") as unknown;
  }
  const { stdout } = await run("sh", ["-lc", 'wmctrl -l 2>/dev/null | sed -E "s/^[^ ]+ +[^ ]+ +[^ ]+ +//" | head -50 || true']);
  return stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
}

async function focusWindow(title: string): Promise<Record<string, unknown>> {
  if (process.platform === "darwin") {
    const script = `
      on run argv
        set needle to item 1 of argv
        tell application "System Events"
          repeat with proc in (application processes whose background only is false)
            set appName to name of proc
            if appName contains needle then
              set frontmost of proc to true
              return appName
            end if
            repeat with win in windows of proc
              try
                if (name of win) contains needle then
                  set frontmost of proc to true
                  perform action "AXRaise" of win
                  return appName & " | " & name of win
                end if
              end try
            end repeat
          end repeat
        end tell
        error "No matching window"
      end run
    `;
    const { stdout } = await run("osascript", ["-e", script, title]);
    return { focused: stdout.trim() };
  }
  if (process.platform === "win32") {
    const escaped = title.replaceAll("'", "''");
    const script = `
      Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class WinFocus {
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
      }
"@;
      $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${escaped}*' -or $_.ProcessName -like '*${escaped}*' } | Select-Object -First 1;
      if (!$p) { throw 'No matching window' }
      [WinFocus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null;
      [WinFocus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;
      "$($p.ProcessName) | $($p.MainWindowTitle)"
    `;
    const { stdout } = await runPowerShell(script);
    return { focused: stdout.trim() };
  }
  const { stdout } = await run("sh", ["-lc", 'wmctrl -a "$1" && echo "$1"', "sh", title]);
  return { focused: stdout.trim() || title };
}

async function launchTarget(target: string, args: string[], waitMs: number): Promise<Record<string, unknown>> {
  let command: string;
  let commandArgs: string[];
  if (process.platform === "darwin") {
    command = "open";
    commandArgs = isProbablyAppName(target) ? ["-a", target, ...openArgs(args)] : [target, ...openArgs(args)];
  } else if (process.platform === "win32") {
    command = "cmd.exe";
    commandArgs = ["/c", "start", "", target, ...args];
  } else {
    command = isUrl(target) || args.length === 0 ? "xdg-open" : target;
    commandArgs = command === "xdg-open" ? [target] : args;
  }
  const child = spawn(command, commandArgs, { detached: true, stdio: "ignore" });
  child.unref();
  await sleep(Math.max(0, waitMs));
  return { command, args: commandArgs, pid: child.pid, target };
}

async function openUrl(url: string, browser?: string): Promise<Record<string, unknown>> {
  if ((process.platform === "darwin" || process.platform === "win32") && browser) {
    return launchTarget(browser, [url], 800);
  }
  return launchTarget(url, [], 800);
}

function defaultScreenshotFormat(): "png" | "jpg" {
  return "jpg";
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("url is required");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function searchUrl(query: string, engine: string): string {
  const q = encodeURIComponent(query);
  if (engine === "bing") return `https://www.bing.com/search?q=${q}`;
  if (engine === "baidu") return `https://www.baidu.com/s?wd=${q}`;
  if (engine === "duckduckgo") return `https://duckduckgo.com/?q=${q}`;
  return `https://www.google.com/search?q=${q}`;
}

function openArgs(args: string[]): string[] {
  return args.length > 0 ? ["--args", ...args] : [];
}

function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function isProbablyAppName(value: string): boolean {
  return !isUrl(value) && !value.includes("/") && !value.includes("\\") && !path.extname(value);
}

function parseKeyCombo(value: string): { key: string; modifiers: string[] } {
  const parts = value.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const modifiers = parts.filter((part) => ["cmd", "command", "ctrl", "control", "alt", "option", "shift"].includes(part));
  const key = parts.find((part) => !modifiers.includes(part)) ?? "";
  return { key, modifiers };
}

function macUsingClause(modifiers: string[]): string {
  const mapped = modifiers.map((modifier) => {
    if (modifier === "cmd" || modifier === "command") return "command down";
    if (modifier === "ctrl" || modifier === "control") return "control down";
    if (modifier === "alt" || modifier === "option") return "option down";
    return "shift down";
  });
  return mapped.length > 0 ? ` using {${mapped.join(", ")}}` : "";
}

function macKeyName(key: string): string {
  const aliases: Record<string, string> = {
    enter: "\r",
    return: "\r",
    escape: String.fromCharCode(27),
    esc: String.fromCharCode(27),
    space: " ",
  };
  return aliases[key] ?? key;
}

function macKeyCode(key: string): number | undefined {
  const aliases: Record<string, number> = {
    enter: 36,
    return: 36,
    tab: 48,
    escape: 53,
    esc: 53,
    backspace: 51,
    delete: 117,
    forwarddelete: 117,
    left: 123,
    arrowleft: 123,
    right: 124,
    arrowright: 124,
    down: 125,
    arrowdown: 125,
    up: 126,
    arrowup: 126,
    home: 115,
    end: 119,
    pageup: 116,
    pagedown: 121,
    space: 49,
  };
  return aliases[key.toLowerCase()];
}

async function pasteTextWithClipboardRestore(text: string): Promise<void> {
  const previous = await readMacClipboard().catch(() => null);
  await writeMacClipboard(text);
  try {
    await run("osascript", ["-e", 'tell application "System Events" to keystroke "v" using {command down}']);
    await sleep(200);
  } finally {
    if (previous !== null) {
      await writeMacClipboard(previous).catch(() => undefined);
    }
  }
}

async function readMacClipboard(): Promise<string> {
  const { stdout } = await run("pbpaste", []);
  return stdout;
}

async function writeMacClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    proc.stdin?.write(text, "utf8");
    proc.stdin?.end();
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited with ${code}`))));
    proc.on("error", reject);
  });
}

function windowsSendKeys(value: string): string {
  const combo = parseKeyCombo(value);
  if (!combo.key) return "";
  const mods = combo.modifiers.map((modifier) => {
    if (modifier === "ctrl" || modifier === "control") return "^";
    if (modifier === "alt" || modifier === "option") return "%";
    if (modifier === "shift") return "+";
    return "";
  }).join("");
  const aliases: Record<string, string> = {
    enter: "{ENTER}",
    return: "{ENTER}",
    escape: "{ESC}",
    esc: "{ESC}",
    tab: "{TAB}",
    space: " ",
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
  };
  return `${mods}${aliases[combo.key] ?? combo.key}`;
}

async function diagnoseKeyboardAutomation(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    platform: process.platform,
    note:
      process.platform === "darwin"
        ? "If keyboard/mouse input fails, grant Accessibility permission to the app/terminal running Neros, then restart it."
        : undefined,
  };
  result.windows = await listWindows().catch((error) => ({ error: errorMessage(error) }));
  result.cursor = await getCursorPosition().catch((error) => ({ error: errorMessage(error) }));
  if (process.platform === "darwin") {
    result.frontmostApp = await getMacFrontmostApp().catch((error) => ({ error: errorMessage(error) }));
    result.systemEvents = await run("osascript", [
      "-e",
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ])
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: errorMessage(error) }));
    result.clipboard = await readMacClipboard()
      .then((value) => ({ ok: true, chars: value.length }))
      .catch((error) => ({ ok: false, error: errorMessage(error) }));
  }
  return result;
}

async function getMacFrontmostApp(): Promise<string> {
  const { stdout } = await run("osascript", [
    "-e",
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ]);
  return stdout.trim();
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function requirePoint(x: number | undefined, y: number | undefined): asserts x is number {
  if (x === undefined || y === undefined) throw new Error("x and y are required for this mouse action");
}

function parseTwoNumbers(value: string, separator: RegExp = /,\s*/): [number, number] {
  const numbers = parseNumbers(value, 2, separator);
  return [numbers[0] as number, numbers[1] as number];
}

function parseFourNumbers(value: string, separator: RegExp = /,\s*/): [number, number, number, number] {
  const numbers = parseNumbers(value, 4, separator);
  return [numbers[0] as number, numbers[1] as number, numbers[2] as number, numbers[3] as number];
}

function parseNumbers(value: string, count: number, separator: RegExp): number[] {
  const numbers = value.trim().split(separator).map(Number);
  if (numbers.length < count || numbers.slice(0, count).some((item) => !Number.isFinite(item))) {
    throw new Error(`Unable to parse numeric output: ${value.trim()}`);
  }
  return numbers.slice(0, count);
}

async function run(command: string, args: string[], timeout = 30_000): Promise<ExecResult> {
  try {
    return await execFile(command, args, {
      timeout,
      maxBuffer: 1024 * 1024 * 8,
      env: { ...process.env, PATH: process.env.PATH ?? defaultPath() },
    });
  } catch (err) {
    throw new Error(`${command} failed: ${errorMessage(err)}`);
  }
}

async function runPowerShell(script: string): Promise<ExecResult> {
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  return run(executable, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultPath(): string {
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", os.homedir()].join(":");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const candidate = err as { stderr?: string; message?: string };
    return candidate.stderr || candidate.message || String(err);
  }
  return String(err);
}
