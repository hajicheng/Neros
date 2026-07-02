import { execFile as execFileCallback, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { workspaceRoot } from '@/server/workspace-service'

import type { ToolDef, ToolResult } from './types'
import { asRecord, readString } from './utils'

const execFile = promisify(execFileCallback)
const MAX_TYPE_LENGTH = 500
const MAX_SCREENSHOT_DATA_URL_BYTES = 4 * 1024 * 1024
const DEFAULT_SCREENSHOT_MAX_WIDTH = 1600
const DEFAULT_SCREENSHOT_JPEG_QUALITY = 72

type ExecResult = { stdout: string; stderr: string }

export const desktopScreenInfoTool: ToolDef = {
  name: 'desktop_get_screen_info',
  description: 'Get host desktop screen information, cursor position when available, and visible window titles.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async handler() {
    return toolOk(await getScreenInfo())
  },
}

export const desktopCaptureScreenTool: ToolDef = {
  name: 'desktop_capture_screen',
  description: 'Capture a host desktop screenshot and return its saved path plus image data for visual inspection.',
  parameters: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['png', 'jpg', 'jpeg'],
        description: 'Screenshot format. Defaults to jpeg, like OpenClaw screen.snapshot.',
      },
      maxWidth: {
        type: 'number',
        description: 'Resize the screenshot to this maximum width. Defaults to 1600.',
      },
      quality: {
        type: 'number',
        description: 'JPEG quality from 0.05 to 1 or 5 to 100. Defaults to 0.72.',
      },
      screenIndex: {
        type: 'number',
        description: 'Display index on macOS. Defaults to the primary/all display capture.',
      },
    },
  },
  async handler(args, ctx) {
    const input = asRecord(args)
    const requestedFormat = readString(input.format)?.toLowerCase()
    const format = requestedFormat === 'png' ? 'png' : 'jpg'
    const maxWidth = normalizePositiveInt(readNumber(input.maxWidth), DEFAULT_SCREENSHOT_MAX_WIDTH)
    const quality = normalizeJpegQuality(readNumber(input.quality))
    const screenIndex = normalizeOptionalInt(readNumber(input.screenIndex))
    const dir = path.join(workspaceRoot(ctx.conversation), '.neros', 'screenshots')
    mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `desktop-${Date.now()}.${format}`)
    await captureScreen(filePath, { format, screenIndex })
    assertCapturedScreenshot(filePath)
    await optimizeScreenshot(filePath, { format, maxWidth, quality })
    assertCapturedScreenshot(filePath)

    const stat = statSync(filePath)
    const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png'
    const relPath = path.relative(workspaceRoot(ctx.conversation), filePath).replaceAll(path.sep, '/')
    const publicUrl = `/api/conversations/${ctx.conversation.id}/fs/raw?path=${encodeURIComponent(relPath)}`
    const value: Record<string, unknown> = {
      path: relPath,
      absolutePath: filePath,
      publicUrl,
      markdown: `![桌面截图](${publicUrl})`,
      mimeType,
      size: stat.size,
      widthLimit: maxWidth,
    }

    if (stat.size <= MAX_SCREENSHOT_DATA_URL_BYTES) {
      const data = readFileSync(filePath).toString('base64')
      value.imageDataUrl = `data:${mimeType};base64,${data}`
    } else {
      value.note = 'Screenshot was saved but is too large to inline as image data.'
    }

    return toolOk(value)
  },
}

export const desktopMouseTool: ToolDef = {
  name: 'desktop_mouse',
  description: 'Control the host mouse: move, click, double_click, right_click, drag, or scroll.',
  parameters: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['move', 'click', 'double_click', 'right_click', 'drag', 'scroll'],
        description: 'Mouse action to perform.',
      },
      x: { type: 'number', description: 'Target x coordinate.' },
      y: { type: 'number', description: 'Target y coordinate.' },
      toX: { type: 'number', description: 'Drag destination x coordinate.' },
      toY: { type: 'number', description: 'Drag destination y coordinate.' },
      amount: { type: 'number', description: 'Scroll amount. Positive scrolls up, negative scrolls down.' },
    },
  },
  async handler(args) {
    const input = asRecord(args)
    const action = readString(input.action)
    if (!action) return toolErr('action is required')
    const x = readNumber(input.x)
    const y = readNumber(input.y)
    const toX = readNumber(input.toX)
    const toY = readNumber(input.toY)
    const amount = readNumber(input.amount)
    await runMouseAction(action, { x, y, toX, toY, amount })
    return toolOk({ action, x, y, toX, toY, amount })
  },
}

export const desktopKeyboardTool: ToolDef = {
  name: 'desktop_keyboard',
  description:
    'Send keyboard input to the active host window: type text, press a key, send a hotkey combo, or diagnose keyboard automation. Can focus a target window and click a target point before typing.',
  parameters: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['type', 'press', 'hotkey', 'diagnose'],
        description: 'Keyboard action to perform.',
      },
      text: { type: 'string', description: 'Text to type. Maximum 500 characters.' },
      key: { type: 'string', description: 'Single key to press, such as enter, escape, tab, or a.' },
      keys: { type: 'string', description: 'Hotkey combo such as cmd+l, ctrl+c, alt+tab, or enter.' },
      targetTitle: { type: 'string', description: 'Optional window/app title substring to focus before sending input.' },
      clickX: { type: 'number', description: 'Optional x coordinate to click before sending input.' },
      clickY: { type: 'number', description: 'Optional y coordinate to click before sending input.' },
      delayMs: { type: 'number', description: 'Optional delay after focusing/clicking before sending input.' },
      method: {
        type: 'string',
        enum: ['auto', 'paste', 'keystroke'],
        description: 'Typing method. macOS auto uses clipboard paste for Unicode.',
      },
    },
  },
  async handler(args) {
    const input = asRecord(args)
    const action = readString(input.action)
    if (!action) return toolErr('action is required')
    if (action === 'diagnose') return toolOk(await diagnoseKeyboardAutomation())
    const text = readString(input.text)
    const key = readString(input.key)
    const keys = readString(input.keys)
    const targetTitle = readString(input.targetTitle)
    const clickX = readNumber(input.clickX)
    const clickY = readNumber(input.clickY)
    const delayMs = Math.max(0, Math.floor(readNumber(input.delayMs) ?? 0))
    const methodRaw = readString(input.method)
    const method = methodRaw === 'paste' || methodRaw === 'keystroke' ? methodRaw : 'auto'
    if (action === 'type' && (text ?? '').length > MAX_TYPE_LENGTH) {
      return toolErr(`text is too long (${text?.length ?? 0} chars, max ${MAX_TYPE_LENGTH})`)
    }
    if (!['type', 'press', 'hotkey'].includes(action)) {
      return toolErr('action must be type, press, hotkey, or diagnose')
    }
    if (targetTitle) {
      await focusWindow(targetTitle)
      await sleep(delayMs || 250)
    }
    if (clickX !== null || clickY !== null) {
      requirePoint(clickX, clickY)
      await runMouseAction('click', { x: clickX, y: clickY, toX: null, toY: null, amount: null })
      await sleep(delayMs || 150)
    } else if (delayMs && !targetTitle) {
      await sleep(delayMs)
    }
    await runKeyboardAction(action, { text: text ?? '', key: key ?? '', keys: keys ?? '', method })
    return toolOk({
      action,
      chars: action === 'type' ? text?.length ?? 0 : undefined,
      key,
      keys,
      targetTitle,
      clicked: clickX !== null && clickY !== null ? { x: clickX, y: clickY } : undefined,
      method,
    })
  },
}

export const desktopWindowTool: ToolDef = {
  name: 'desktop_window',
  description: 'List host windows or focus a window whose title/app name contains text.',
  parameters: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['list', 'focus'], description: 'Window action.' },
      title: { type: 'string', description: 'Case-insensitive title/app substring for focus.' },
    },
  },
  async handler(args) {
    const input = asRecord(args)
    const action = readString(input.action)
    if (action === 'list') return toolOk(await listWindows())
    if (action === 'focus') {
      const title = readString(input.title)
      if (!title) return toolErr('title is required for focus')
      return toolOk(await focusWindow(title))
    }
    return toolErr('action must be list or focus')
  },
}

export const appLaunchTool: ToolDef = {
  name: 'app_launch',
  description: 'Launch a host application, file, directory, or URL.',
  parameters: {
    type: 'object',
    required: ['target'],
    properties: {
      target: { type: 'string', description: 'Application name/path, file path, directory path, or URL.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Optional process arguments.' },
      waitMs: { type: 'number', description: 'Optional wait time before returning.' },
    },
  },
  async handler(args) {
    const input = asRecord(args)
    const target = readString(input.target)
    if (!target) return toolErr('target is required')
    const launchArgs = Array.isArray(input.args)
      ? input.args.filter((item): item is string => typeof item === 'string')
      : []
    const waitMs = readNumber(input.waitMs) ?? 1200
    const result = await launchTarget(target, launchArgs, waitMs)
    return toolOk(result)
  },
}

export const browserOpenTool: ToolDef = {
  name: 'browser_open',
  description: 'Open a URL in the host browser or a named browser application.',
  parameters: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'URL to open.' },
      browser: { type: 'string', description: 'Optional browser name, such as Safari, Google Chrome, Edge, or Firefox.' },
    },
  },
  async handler(args) {
    const input = asRecord(args)
    const url = normalizeUrl(readString(input.url) ?? '')
    if (!url) return toolErr('url is required')
    const browser = readString(input.browser)
    return toolOk(await openUrl(url, browser ?? undefined))
  },
}

export const browserSearchTool: ToolDef = {
  name: 'browser_search',
  description: 'Search the web in the host browser using Google, Bing, Baidu, or DuckDuckGo.',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query.' },
      engine: {
        type: 'string',
        enum: ['google', 'bing', 'baidu', 'duckduckgo'],
        description: 'Search engine. Defaults to google.',
      },
      browser: { type: 'string', description: 'Optional browser application name.' },
    },
  },
  async handler(args) {
    const input = asRecord(args)
    const query = readString(input.query)
    if (!query) return toolErr('query is required')
    const engine = readString(input.engine) ?? 'google'
    const browser = readString(input.browser)
    return toolOk(await openUrl(searchUrl(query, engine), browser ?? undefined))
  },
}

async function getScreenInfo(): Promise<Record<string, unknown>> {
  const [screen, windows, cursor] = await Promise.all([
    getScreenBounds().catch((error) => ({ error: errorMessage(error) })),
    listWindows().catch((error) => ({ error: errorMessage(error) })),
    getCursorPosition().catch(() => null),
  ])
  return { platform: process.platform, screen, cursor, windows }
}

async function getScreenBounds(): Promise<unknown> {
  if (process.platform === 'darwin') {
    const { stdout } = await run('osascript', [
      '-e',
      'tell application "Finder" to get bounds of window of desktop',
    ])
    const [left, top, right, bottom] = parseFourNumbers(stdout)
    return { left, top, width: right - left, height: bottom - top }
  }
  if (process.platform === 'win32') {
    const script = '[System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($s.Left),$($s.Top),$($s.Width),$($s.Height)"'
    const { stdout } = await runPowerShell(script)
    const [left, top, width, height] = parseFourNumbers(stdout)
    return { left, top, width, height }
  }
  const { stdout } = await run('sh', ['-lc', 'xdpyinfo | awk \'/dimensions:/ {print $2; exit}\''])
  const [width, height] = parseTwoNumbers(stdout, /x/)
  return { left: 0, top: 0, width, height }
}

async function getCursorPosition(): Promise<{ x: number; y: number } | null> {
  if (process.platform === 'darwin') {
    const script = [
      'from Quartz import CGEventCreate, CGEventGetLocation',
      'loc = CGEventGetLocation(CGEventCreate(None))',
      'print(f"{int(loc.x)},{int(loc.y)}")',
    ].join('\n')
    const { stdout } = await run('python3', ['-c', script])
    const [x, y] = parseTwoNumbers(stdout)
    return { x, y }
  }
  if (process.platform === 'win32') {
    const script = '[System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'
    const { stdout } = await runPowerShell(script)
    const [x, y] = parseTwoNumbers(stdout)
    return { x, y }
  }
  const { stdout } = await run('sh', ['-lc', 'xdotool getmouselocation --shell | awk -F= \'/^[XY]=/ {print $2}\' | paste -sd, -'])
  const [x, y] = parseTwoNumbers(stdout)
  return { x, y }
}

let _nativeScreenshotPath: string | null | undefined

async function findNativeScreenshot(): Promise<string | null> {
  if (_nativeScreenshotPath !== undefined) return _nativeScreenshotPath

  const candidates = [
    path.resolve(process.cwd(), 'native', 'neros-screenshot', 'dist', 'NeroScreenshot.app', 'Contents', 'MacOS', 'neros-screenshot'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'native', 'neros-screenshot', 'dist', 'NeroScreenshot.app', 'Contents', 'MacOS', 'neros-screenshot'),
  ]

  for (const candidate of candidates) {
    try {
      await access(candidate)
      _nativeScreenshotPath = candidate
      return candidate
    } catch {
      // not found, try next
    }
  }

  _nativeScreenshotPath = null
  return null
}

async function captureScreen(
  filePath: string,
  opts: { format: 'png' | 'jpg'; screenIndex: number | null },
): Promise<void> {
  if (process.platform === 'darwin') {
    const nativeBin = await findNativeScreenshot()
    if (nativeBin) {
      try {
        const nativeArgs = ['--format', opts.format, '--output', filePath, '--max-width', '1600', '--quality', '0.72']
        if (typeof opts.screenIndex === 'number') {
          nativeArgs.push('--screen-index', String(opts.screenIndex))
        }
        await run(nativeBin, nativeArgs)
        return
      } catch (err) {
        const msg = errorMessage(err)
        if (msg.includes('TCC') || msg.includes('denied') || msg.includes('permission')) {
          throw new Error(
            `macOS 截屏失败：需要屏幕录制权限。\n\n` +
            `请到 系统设置 → 隐私与安全性 → 屏幕录制，找到 "NeroScreenshot" 并开启。\n` +
            `授权后需要重启 Neros dev server。`,
          )
        }
      }
    }
    try {
      const args = ['-x', '-t', opts.format]
      if (typeof opts.screenIndex === 'number') args.push('-D', String(opts.screenIndex + 1))
      args.push(filePath)
      await run('screencapture', args)
    } catch (err) {
      throw new Error(
        `macOS 截屏失败: ${errorMessage(err)}.\n\n` +
        `方案一（推荐）：在项目根目录运行 native/neros-screenshot/build.sh 构建原生截图工具，然后在系统设置中授权 NeroScreenshot。\n` +
        `方案二：到 系统设置 → 隐私与安全性 → 屏幕录制，给启动 Neros 的终端应用（如 VS Code）授权，然后 Cmd+Q 完全退出重启。`,
      )
    }
    return
  }
  if (process.platform === 'win32') {
    const imageFormat = opts.format === 'jpg' ? 'Jpeg' : 'Png'
    const escapedPath = filePath.replaceAll("'", "''")
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
    `)
    return
  }
  await run('sh', ['-lc', `gnome-screenshot -f "$1" || spectacle -b -o "$1" || import -window root "$1"`, 'sh', filePath])
}

async function optimizeScreenshot(
  filePath: string,
  opts: { format: 'png' | 'jpg'; maxWidth: number; quality: number },
): Promise<void> {
  if (process.platform === 'darwin') {
    const args =
      opts.format === 'jpg'
        ? [
            '-Z',
            String(opts.maxWidth),
            '-s',
            'format',
            'jpeg',
            '-s',
            'formatOptions',
            String(opts.quality),
            filePath,
            '--out',
            filePath,
          ]
        : ['-Z', String(opts.maxWidth), filePath, '--out', filePath]
    await run('sips', args).catch(() => undefined)
    return
  }
  if (process.platform === 'linux') {
    await run('sh', [
      '-lc',
      'if command -v magick >/dev/null 2>&1; then magick "$1" -resize "$2"x"$2"\\> -quality "$3" "$1"; elif command -v convert >/dev/null 2>&1; then convert "$1" -resize "$2"x"$2"\\> -quality "$3" "$1"; fi',
      'sh',
      filePath,
      String(opts.maxWidth),
      String(opts.quality),
    ]).catch(() => undefined)
  }
}

function assertCapturedScreenshot(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error('截图失败：截屏命令没有生成图片文件。')
  }
  const stat = statSync(filePath)
  if (stat.size <= 0) {
    throw new Error('截图失败：截屏命令生成了空图片文件。')
  }
}

function normalizePositiveInt(value: number | null, fallback: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.round(value))
}

function normalizeOptionalInt(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

function normalizeJpegQuality(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return DEFAULT_SCREENSHOT_JPEG_QUALITY
  const normalized = value <= 1 ? value * 100 : value
  return Math.min(100, Math.max(5, Math.round(normalized)))
}

async function runMouseAction(
  action: string,
  input: { x: number | null; y: number | null; toX: number | null; toY: number | null; amount: number | null },
): Promise<void> {
  if (process.platform === 'darwin') return runMacMouseAction(action, input)
  if (process.platform === 'win32') return runWindowsMouseAction(action, input)
  return runLinuxMouseAction(action, input)
}

async function runMacMouseAction(
  action: string,
  input: { x: number | null; y: number | null; toX: number | null; toY: number | null; amount: number | null },
): Promise<void> {
  if (action === 'scroll') {
    await run('osascript', ['-e', `tell application "System Events" to scroll wheel ${Math.round(input.amount ?? 0)}`])
    return
  }
  requirePoint(input.x, input.y)
  if (action === 'click') {
    await run('osascript', ['-e', `tell application "System Events" to click at {${input.x}, ${input.y}}`])
    return
  }
  const script = macQuartzMouseScript(action, input)
  await run('python3', ['-c', script])
}

async function runWindowsMouseAction(
  action: string,
  input: { x: number | null; y: number | null; toX: number | null; toY: number | null; amount: number | null },
): Promise<void> {
  if (action !== 'scroll') requirePoint(input.x, input.y)
  const script = `
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
  `
  await runPowerShell(script)
}

async function runLinuxMouseAction(
  action: string,
  input: { x: number | null; y: number | null; toX: number | null; toY: number | null; amount: number | null },
): Promise<void> {
  if (action === 'scroll') {
    const button = (input.amount ?? 0) >= 0 ? '4' : '5'
    const count = Math.max(1, Math.abs(Math.round(input.amount ?? 0)))
    await run('xdotool', ['click', '--repeat', String(count), button])
    return
  }
  requirePoint(input.x, input.y)
  if (action === 'move') await run('xdotool', ['mousemove', String(input.x), String(input.y)])
  else if (action === 'click') await run('xdotool', ['mousemove', String(input.x), String(input.y), 'click', '1'])
  else if (action === 'double_click') await run('xdotool', ['mousemove', String(input.x), String(input.y), 'click', '--repeat', '2', '1'])
  else if (action === 'right_click') await run('xdotool', ['mousemove', String(input.x), String(input.y), 'click', '3'])
  else if (action === 'drag') {
    requirePoint(input.toX, input.toY)
    await run('xdotool', ['mousemove', String(input.x), String(input.y), 'mousedown', '1', 'mousemove', String(input.toX), String(input.toY), 'mouseup', '1'])
  } else {
    throw new Error(`Unknown mouse action: ${action}`)
  }
}

function macQuartzMouseScript(
  action: string,
  input: { x: number | null; y: number | null; toX: number | null; toY: number | null },
): string {
  const x = input.x ?? 0
  const y = input.y ?? 0
  const toX = input.toX ?? x
  const toY = input.toY ?? y
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
else:
    raise SystemExit("Unknown mouse action")
`
}

async function runKeyboardAction(
  action: string,
  input: { text: string; key: string; keys: string; method?: 'auto' | 'paste' | 'keystroke' },
): Promise<void> {
  if (process.platform === 'darwin') return runMacKeyboardAction(action, input)
  if (process.platform === 'win32') return runWindowsKeyboardAction(action, input)
  return runLinuxKeyboardAction(action, input)
}

async function runMacKeyboardAction(
  action: string,
  input: { text: string; key: string; keys: string; method?: 'auto' | 'paste' | 'keystroke' },
): Promise<void> {
  if (action === 'type') {
    if (!input.text) throw new Error('text is required')
    if (input.method === 'keystroke') {
      await run('osascript', [
        '-e',
        'on run argv',
        '-e',
        'tell application "System Events" to keystroke (item 1 of argv)',
        '-e',
        'end run',
        input.text,
      ])
      return
    }
    await pasteTextWithClipboardRestore(input.text)
    return
  }
  const combo = parseKeyCombo(action === 'hotkey' ? input.keys : input.key)
  if (!combo.key) throw new Error(action === 'hotkey' ? 'keys is required' : 'key is required')
  const using = macUsingClause(combo.modifiers)
  const keyCode = macKeyCode(combo.key)
  if (keyCode !== undefined) {
    await run('osascript', ['-e', `tell application "System Events" to key code ${keyCode}${using}`])
    return
  }
  const keyName = macKeyName(combo.key)
  await run('osascript', ['-e', `tell application "System Events" to keystroke "${escapeAppleScriptString(keyName)}"${using}`])
}

async function runWindowsKeyboardAction(action: string, input: { text: string; key: string; keys: string }): Promise<void> {
  const payload = action === 'type' ? input.text : windowsSendKeys(action === 'hotkey' ? input.keys : input.key)
  if (!payload) throw new Error(action === 'hotkey' ? 'keys is required' : 'key/text is required')
  await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${payload.replaceAll("'", "''")}')`)
}

async function runLinuxKeyboardAction(action: string, input: { text: string; key: string; keys: string }): Promise<void> {
  if (action === 'type') {
    if (!input.text) throw new Error('text is required')
    await run('xdotool', ['type', '--delay', '15', input.text])
    return
  }
  const keys = action === 'hotkey' ? input.keys : input.key
  if (!keys) throw new Error(action === 'hotkey' ? 'keys is required' : 'key is required')
  await run('xdotool', ['key', keys.replaceAll('+', '+')])
}

async function listWindows(): Promise<unknown> {
  if (process.platform === 'darwin') {
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
    `
    const { stdout } = await run('osascript', ['-e', script])
    return stdout.trim() ? stdout.trim().split(/,\s*/).slice(0, 50) : []
  }
  if (process.platform === 'win32') {
    const { stdout } = await runPowerShell('Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -First 50 ProcessName,MainWindowTitle | ConvertTo-Json -Compress')
    return parseJson(stdout, [])
  }
  const { stdout } = await run('sh', ['-lc', 'wmctrl -l 2>/dev/null | sed -E "s/^[^ ]+ +[^ ]+ +[^ ]+ +//" | head -50 || true'])
  return stdout.trim() ? stdout.trim().split(/\r?\n/) : []
}

async function focusWindow(title: string): Promise<Record<string, unknown>> {
  if (process.platform === 'darwin') {
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
    `
    const { stdout } = await run('osascript', ['-e', script, title])
    return { focused: stdout.trim() }
  }
  if (process.platform === 'win32') {
    const escaped = title.replaceAll("'", "''")
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
    `
    const { stdout } = await runPowerShell(script)
    return { focused: stdout.trim() }
  }
  const { stdout } = await run('sh', ['-lc', 'wmctrl -a "$1" && echo "$1"', 'sh', title])
  return { focused: stdout.trim() || title }
}

async function launchTarget(target: string, args: string[], waitMs: number): Promise<Record<string, unknown>> {
  let command: string
  let commandArgs: string[]
  if (process.platform === 'darwin') {
    command = 'open'
    commandArgs = isProbablyAppName(target) ? ['-a', target, ...openArgs(args)] : [target, ...openArgs(args)]
  } else if (process.platform === 'win32') {
    command = 'cmd.exe'
    commandArgs = ['/c', 'start', '', target, ...args]
  } else {
    command = isUrl(target) || args.length === 0 ? 'xdg-open' : target
    commandArgs = command === 'xdg-open' ? [target] : args
  }
  const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore' })
  child.unref()
  await sleep(Math.max(0, waitMs))
  return { command, args: commandArgs, pid: child.pid, target }
}

async function openUrl(url: string, browser?: string): Promise<Record<string, unknown>> {
  if (process.platform === 'darwin' && browser) return launchTarget(browser, [url], 800)
  if (process.platform === 'win32' && browser) return launchTarget(browser, [url], 800)
  return launchTarget(url, [], 800)
}

function openArgs(args: string[]): string[] {
  return args.length > 0 ? ['--args', ...args] : []
}

function defaultScreenshotFormat(): 'png' | 'jpg' {
  return 'jpg'
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function searchUrl(query: string, engine: string): string {
  const q = encodeURIComponent(query)
  if (engine === 'bing') return `https://www.bing.com/search?q=${q}`
  if (engine === 'baidu') return `https://www.baidu.com/s?wd=${q}`
  if (engine === 'duckduckgo') return `https://duckduckgo.com/?q=${q}`
  return `https://www.google.com/search?q=${q}`
}

function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

function isProbablyAppName(value: string): boolean {
  return !isUrl(value) && !value.includes('/') && !value.includes('\\') && !path.extname(value)
}

function parseKeyCombo(value: string): { key: string; modifiers: string[] } {
  const parts = value
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  const modifiers = parts.filter((part) => ['cmd', 'command', 'ctrl', 'control', 'alt', 'option', 'shift'].includes(part))
  const key = parts.find((part) => !modifiers.includes(part)) ?? ''
  return { key, modifiers }
}

function macUsingClause(modifiers: string[]): string {
  const mapped = modifiers.map((modifier) => {
    if (modifier === 'cmd' || modifier === 'command') return 'command down'
    if (modifier === 'ctrl' || modifier === 'control') return 'control down'
    if (modifier === 'alt' || modifier === 'option') return 'option down'
    return 'shift down'
  })
  return mapped.length > 0 ? ` using {${mapped.join(', ')}}` : ''
}

function macKeyName(key: string): string {
  const aliases: Record<string, string> = {
    enter: '\r',
    return: '\r',
    escape: String.fromCharCode(27),
    esc: String.fromCharCode(27),
    space: ' ',
  }
  return aliases[key] ?? key
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
  }
  return aliases[key.toLowerCase()]
}

async function pasteTextWithClipboardRestore(text: string): Promise<void> {
  const previous = await readMacClipboard().catch(() => null)
  await writeMacClipboard(text)
  try {
    await run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using {command down}'])
    await sleep(200)
  } finally {
    if (previous !== null) {
      await writeMacClipboard(previous).catch(() => undefined)
    }
  }
}

async function readMacClipboard(): Promise<string> {
  const { stdout } = await run('pbpaste', [])
  return stdout
}

async function writeMacClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
    proc.stdin?.write(text, 'utf8')
    proc.stdin?.end()
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited with ${code}`))))
    proc.on('error', reject)
  })
}

function windowsSendKeys(value: string): string {
  const combo = parseKeyCombo(value)
  if (!combo.key) return ''
  const mods = combo.modifiers
    .map((modifier) => {
      if (modifier === 'ctrl' || modifier === 'control') return '^'
      if (modifier === 'alt' || modifier === 'option') return '%'
      if (modifier === 'shift') return '+'
      return ''
    })
    .join('')
  const aliases: Record<string, string> = {
    enter: '{ENTER}',
    return: '{ENTER}',
    escape: '{ESC}',
    esc: '{ESC}',
    tab: '{TAB}',
    space: ' ',
    backspace: '{BACKSPACE}',
    delete: '{DELETE}',
  }
  return `${mods}${aliases[combo.key] ?? combo.key}`
}

async function diagnoseKeyboardAutomation(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    platform: process.platform,
    note:
      process.platform === 'darwin'
        ? 'If keyboard/mouse input fails, grant Accessibility permission to the app/terminal running Neros, then restart it.'
        : undefined,
  }
  result.windows = await listWindows().catch((error) => ({ error: errorMessage(error) }))
  result.cursor = await getCursorPosition().catch((error) => ({ error: errorMessage(error) }))
  if (process.platform === 'darwin') {
    result.frontmostApp = await getMacFrontmostApp().catch((error) => ({ error: errorMessage(error) }))
    result.systemEvents = await run('osascript', [
      '-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ])
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: errorMessage(error) }))
    result.clipboard = await readMacClipboard()
      .then((value) => ({ ok: true, chars: value.length }))
      .catch((error) => ({ ok: false, error: errorMessage(error) }))
  }
  return result
}

async function getMacFrontmostApp(): Promise<string> {
  const { stdout } = await run('osascript', [
    '-e',
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ])
  return stdout.trim()
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function requirePoint(x: number | null, y: number | null): asserts x is number {
  if (x === null || y === null) throw new Error('x and y are required for this mouse action')
}

function parseTwoNumbers(value: string, separator: RegExp = /,\s*/): [number, number] {
  const numbers = parseNumbers(value, 2, separator)
  return [numbers[0] as number, numbers[1] as number]
}

function parseFourNumbers(value: string, separator: RegExp = /,\s*/): [number, number, number, number] {
  const numbers = parseNumbers(value, 4, separator)
  return [numbers[0] as number, numbers[1] as number, numbers[2] as number, numbers[3] as number]
}

function parseNumbers(value: string, count: number, separator: RegExp): number[] {
  const numbers = value.trim().split(separator).map(Number)
  if (numbers.length < count || numbers.slice(0, count).some((item) => !Number.isFinite(item))) {
    throw new Error(`Unable to parse numeric output: ${value.trim()}`)
  }
  return numbers.slice(0, count)
}

async function run(command: string, args: string[], timeout = 30_000): Promise<ExecResult> {
  try {
    return await execFile(command, args, {
      timeout,
      maxBuffer: 1024 * 1024 * 8,
      env: { ...process.env, PATH: process.env.PATH ?? defaultPath() },
    })
  } catch (err) {
    const detail = errorMessage(err)
    throw new Error(`${command} failed: ${detail}`)
  }
}

async function runPowerShell(script: string): Promise<ExecResult> {
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  return run(executable, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
}

function parseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultPath(): string {
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', os.homedir()].join(':')
}

function toolOk(value: unknown): ToolResult {
  return { ok: true, value }
}

function toolErr(error: string): ToolResult {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const candidate = err as { stderr?: string; message?: string }
    return candidate.stderr || candidate.message || String(err)
  }
  return String(err)
}
