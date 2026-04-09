import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const windowInfoScriptPath = path.join(__dirname, "window-info.ps1");
const focusWindowScriptPath = path.join(__dirname, "focus-window.ps1");
const inputEventsScriptPath = path.join(__dirname, "input-events.ps1");
const outputRoot = path.join(os.homedir(), ".codex", "tmp", "app-window-recorder");

const DEFAULT_CAPTURE_FPS = 60;
const DEFAULT_FRAME_SAMPLE_FPS = 2;
const DEFAULT_SETTLE_SECONDS = 1;
const DEFAULT_LAUNCH_TIMEOUT_SECONDS = 20;
const INPUT_RECORDER_STARTUP_GRACE_MS = 750;
const INPUT_RECORDER_TAIL_GRACE_MS = 250;
const MAX_DURATION_SECONDS = 60;

class RecorderError extends Error {}
class DependencyError extends RecorderError {}
class ValidationError extends RecorderError {}
class WindowSelectionError extends RecorderError {}
class LaunchTimeoutError extends RecorderError {}

function buildToolResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function normalizeProcessName(name) {
  if (!name) {
    return null;
  }

  return String(name).trim().toLowerCase().replace(/\.exe$/i, "");
}

function normalizeTitleContains(title) {
  if (!title) {
    return null;
  }

  return String(title).trim().toLowerCase();
}

function ensurePositiveInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}.`);
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string.`);
  }
}

function ensureRect(rect, label) {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new WindowSelectionError(`${label} has zero size.`);
  }
}

function getPrimaryVideoStream(ffprobe) {
  if (!ffprobe || !Array.isArray(ffprobe.streams) || ffprobe.streams.length === 0) {
    return null;
  }

  const stream = ffprobe.streams[0];
  if (stream.width == null || stream.height == null) {
    return null;
  }

  return {
    width: Number(stream.width),
    height: Number(stream.height),
    avg_frame_rate: stream.avg_frame_rate ?? null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeWindow(windowInfo) {
  return {
    hwnd: windowInfo.hwnd,
    pid: windowInfo.pid,
    process_name: windowInfo.process_name,
    title: windowInfo.title,
    window_rect: windowInfo.window_rect,
    client_rect: windowInfo.client_rect,
  };
}

function formatCandidates(candidates) {
  return candidates.map((candidate) => ({
    hwnd: candidate.hwnd,
    pid: candidate.pid,
    process_name: candidate.process_name,
    title: candidate.title,
  }));
}

function matchesWindow(windowInfo, selector) {
  if (selector.hwnd != null && String(windowInfo.hwnd) !== String(selector.hwnd)) {
    return false;
  }

  if (selector.pid != null && Number(windowInfo.pid) !== Number(selector.pid)) {
    return false;
  }

  if (selector.process_name) {
    if (normalizeProcessName(windowInfo.process_name) !== normalizeProcessName(selector.process_name)) {
      return false;
    }
  }

  if (selector.window_title_contains) {
    const wantedTitle = normalizeTitleContains(selector.window_title_contains);
    const actualTitle = normalizeTitleContains(windowInfo.title) ?? "";
    if (!actualTitle.includes(wantedTitle)) {
      return false;
    }
  }

  return true;
}

function filterWindows(windows, selector) {
  return windows.filter((windowInfo) => matchesWindow(windowInfo, selector));
}

function buildSelectionLabel(selector) {
  const parts = [];

  if (selector.hwnd != null) {
    parts.push(`hwnd=${selector.hwnd}`);
  }
  if (selector.pid != null) {
    parts.push(`pid=${selector.pid}`);
  }
  if (selector.process_name) {
    parts.push(`process_name=${selector.process_name}`);
  }
  if (selector.window_title_contains) {
    parts.push(`window_title_contains=${selector.window_title_contains}`);
  }

  return parts.length > 0 ? parts.join(", ") : "no selector";
}

function chooseUniqueWindow(windows, selector, contextLabel) {
  const candidates = filterWindows(windows, selector);

  if (candidates.length === 0) {
    throw new WindowSelectionError(`No visible top-level window matched ${contextLabel}: ${buildSelectionLabel(selector)}.`);
  }

  if (candidates.length > 1) {
    throw new WindowSelectionError(
      `Multiple visible top-level windows matched ${contextLabel}: ${buildSelectionLabel(selector)}.\n` +
        JSON.stringify(formatCandidates(candidates), null, 2),
    );
  }

  return candidates[0];
}

async function runProcess(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? pluginRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

function startTrackedProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? pluginRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const completion = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });

  return {
    child,
    completion,
  };
}

async function ensureBinary(binaryName) {
  try {
    const result = await runProcess(binaryName, ["-version"]);
    if (result.code !== 0) {
      throw new DependencyError(`${binaryName} is installed but returned exit code ${result.code}. stderr: ${result.stderr.trim()}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new DependencyError(`Required dependency '${binaryName}' is not installed or is not on PATH.`);
    }
    throw error;
  }
}

async function focusWindow(hwnd) {
  const result = await runProcess("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    focusWindowScriptPath,
    "-Hwnd",
    String(hwnd),
  ]);

  if (result.code !== 0) {
    throw new RecorderError(`Failed to activate window ${hwnd}. stderr: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return null;
  }

  try {
    const decoded = Buffer.from(stdout, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch (error) {
    throw new RecorderError(`Failed to parse window activation output. ${error.message}`);
  }
}

function enrichInputEvent(event, targetWindow, captureRect, captureStartedAtUnixMs, captureFinishedAtUnixMs) {
  const timestampUnixMs = Number(event.timestamp_unix_ms);
  const enrichedEvent = {
    ...event,
    timestamp_unix_ms: timestampUnixMs,
    offset_ms: timestampUnixMs - captureStartedAtUnixMs,
    within_capture_interval:
      Number.isFinite(timestampUnixMs) &&
      timestampUnixMs >= captureStartedAtUnixMs &&
      timestampUnixMs <= captureFinishedAtUnixMs,
    target_window_active:
      Number(event.foreground_pid) === Number(targetWindow.pid) ||
      String(event.foreground_hwnd) === String(targetWindow.hwnd),
  };

  if (event.screen_x != null && event.screen_y != null) {
    const screenX = Number(event.screen_x);
    const screenY = Number(event.screen_y);
    const insideCaptureRect =
      screenX >= captureRect.left &&
      screenX < captureRect.right &&
      screenY >= captureRect.top &&
      screenY < captureRect.bottom;

    enrichedEvent.screen_x = screenX;
    enrichedEvent.screen_y = screenY;
    enrichedEvent.inside_capture_rect = insideCaptureRect;

    if (insideCaptureRect) {
      enrichedEvent.capture_x = screenX - captureRect.left;
      enrichedEvent.capture_y = screenY - captureRect.top;
    }
  }

  return enrichedEvent;
}

async function startInputRecorder(sessionDir, input) {
  const inputEventsPath = path.join(sessionDir, "input-events.json");
  const durationMilliseconds =
    input.duration_seconds * 1000 + INPUT_RECORDER_STARTUP_GRACE_MS + INPUT_RECORDER_TAIL_GRACE_MS;
  const { completion } = startTrackedProcess(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      inputEventsScriptPath,
      "-DurationMilliseconds",
      String(durationMilliseconds),
      "-OutputPath",
      inputEventsPath,
    ],
    {
      cwd: sessionDir,
    },
  );

  return {
    inputEventsPath,
    durationMilliseconds,
    completion,
  };
}

async function finalizeInputRecorder(
  recorder,
  sessionDir,
  targetWindow,
  captureRect,
  captureStartedAtUnixMs,
  captureFinishedAtUnixMs,
) {
  const result = await recorder.completion;
  if (result.code !== 0) {
    throw new RecorderError(
      `Input recorder failed with exit code ${result.code}. stderr: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  let rawPayload;
  try {
    const rawJson = (await fs.readFile(recorder.inputEventsPath, "utf8")).replace(/^\uFEFF/, "");
    rawPayload = JSON.parse(rawJson);
  } catch (error) {
    throw new RecorderError(`Failed to read input events from ${recorder.inputEventsPath}. ${error.message}`);
  }

  const rawEvents = Array.isArray(rawPayload.events) ? rawPayload.events : [];
  const filteredEvents = rawEvents
    .map((event) => enrichInputEvent(event, targetWindow, captureRect, captureStartedAtUnixMs, captureFinishedAtUnixMs))
    .filter((event) => event.within_capture_interval);

  const normalizedPayload = {
    recorded_at: new Date().toISOString(),
    session_directory: sessionDir,
    target_window: summarizeWindow(targetWindow),
    capture_rect: captureRect,
    capture_started_at_unix_ms: captureStartedAtUnixMs,
    capture_finished_at_unix_ms: captureFinishedAtUnixMs,
    recorder_started_at_unix_ms: Number(rawPayload.started_at_unix_ms) || null,
    recorder_finished_at_unix_ms: Number(rawPayload.finished_at_unix_ms) || null,
    recorder_duration_ms: Number(rawPayload.duration_ms) || null,
    event_count: filteredEvents.length,
    events: filteredEvents,
  };

  await fs.writeFile(recorder.inputEventsPath, JSON.stringify(normalizedPayload, null, 2));

  return normalizedPayload;
}

async function listVisibleWindows() {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    windowInfoScriptPath,
  ];

  const result = await runProcess("powershell", args);
  if (result.code !== 0) {
    throw new RecorderError(`Failed to enumerate windows. stderr: ${result.stderr.trim()}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return [];
  }

  try {
    const decoded = Buffer.from(stdout, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    throw new RecorderError(`Failed to parse window enumeration output. ${error.message}`);
  }
}

function buildLaunchSelectors(input, launchedProcess) {
  const selectors = [];

  if (launchedProcess?.pid != null) {
    selectors.push({ pid: launchedProcess.pid });
  }

  if (input.pid != null) {
    selectors.push({ pid: input.pid });
  }

  if (input.process_name) {
    selectors.push({
      process_name: input.process_name,
      window_title_contains: input.window_title_contains ?? undefined,
    });
  } else if (launchedProcess?.derivedProcessName) {
    selectors.push({
      process_name: launchedProcess.derivedProcessName,
      window_title_contains: input.window_title_contains ?? undefined,
    });
  }

  if (input.window_title_contains && !input.process_name) {
    selectors.push({ window_title_contains: input.window_title_contains });
  }

  return selectors.filter((selector) => Object.values(selector).some((value) => value != null));
}

async function waitForWindow(input, launchedProcess) {
  const selectors = buildLaunchSelectors(input, launchedProcess);
  const deadline = Date.now() + DEFAULT_LAUNCH_TIMEOUT_SECONDS * 1000;
  let lastWindows = [];

  while (Date.now() < deadline) {
    lastWindows = await listVisibleWindows();

    for (const selector of selectors) {
      const candidates = filterWindows(lastWindows, selector);
      if (candidates.length === 1) {
        return candidates[0];
      }

      if (candidates.length > 1) {
        throw new WindowSelectionError(
          `Multiple windows matched launch selector ${buildSelectionLabel(selector)}.\n` +
            JSON.stringify(formatCandidates(candidates), null, 2),
        );
      }
    }

    await sleep(500);
  }

  throw new LaunchTimeoutError(
    `Timed out after ${DEFAULT_LAUNCH_TIMEOUT_SECONDS} seconds waiting for a visible top-level window. ` +
      `Last selector set: ${selectors.map((selector) => buildSelectionLabel(selector)).join(" | ") || "none"}. ` +
      `Visible windows seen: ${JSON.stringify(formatCandidates(lastWindows), null, 2)}`,
  );
}

async function launchTargetProcess(input) {
  ensureNonEmptyString(input.launch_command, "launch_command");

  const launchArgs = Array.isArray(input.launch_args) ? input.launch_args : [];
  const cwd = input.cwd?.trim() ? input.cwd : pluginRoot;

  return await new Promise((resolve, reject) => {
    const child = spawn(input.launch_command, launchArgs, {
      cwd,
      windowsHide: false,
      stdio: "ignore",
      shell: false,
      detached: false,
    });

    child.once("error", (error) => {
      reject(new RecorderError(`Failed to launch '${input.launch_command}'. ${error.message}`));
    });

    child.once("spawn", () => {
      resolve({
        pid: child.pid ?? null,
        launch_command: input.launch_command,
        launch_args: launchArgs,
        cwd,
        launch_started_at: new Date().toISOString(),
        derivedProcessName: normalizeProcessName(path.basename(input.launch_command)),
      });
    });
  });
}

function normalizeRecordInput(input) {
  ensurePositiveInteger(input.duration_seconds, "duration_seconds", { min: 1, max: MAX_DURATION_SECONDS });

  const captureFps = input.capture_fps ?? DEFAULT_CAPTURE_FPS;
  const frameSampleFps = input.frame_sample_fps ?? DEFAULT_FRAME_SAMPLE_FPS;
  const settleSeconds = input.settle_seconds ?? DEFAULT_SETTLE_SECONDS;
  const clientAreaOnly = input.client_area_only ?? true;
  const preserveMp4 = input.preserve_mp4 ?? true;

  ensurePositiveInteger(captureFps, "capture_fps", { min: 1, max: 60 });
  ensurePositiveInteger(frameSampleFps, "frame_sample_fps", { min: 1, max: 10 });

  if (typeof settleSeconds !== "number" || Number.isNaN(settleSeconds) || settleSeconds < 0 || settleSeconds > 10) {
    throw new ValidationError("settle_seconds must be a number between 0 and 10.");
  }

  if (!input.launch_command && input.pid == null && !input.process_name && !input.window_title_contains) {
    throw new ValidationError("Provide launch_command or at least one attach selector: pid, process_name, or window_title_contains.");
  }

  return {
    ...input,
    capture_fps: captureFps,
    frame_sample_fps: frameSampleFps,
    settle_seconds: settleSeconds,
    client_area_only: clientAreaOnly,
    preserve_mp4: preserveMp4,
  };
}

async function createSessionDirectory() {
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(outputRoot, sessionId);
  const framesDir = path.join(sessionDir, "frames");

  await fs.mkdir(framesDir, { recursive: true });

  return {
    sessionId,
    sessionDir,
    framesDir,
  };
}

function getCaptureGeometry(windowInfo, clientAreaOnly) {
  ensureRect(windowInfo.window_rect, "window_rect");

  if (clientAreaOnly) {
    ensureRect(windowInfo.client_rect, "client_rect");

    return {
      backend: "hwnd-window-client-crop",
      rect: windowInfo.client_rect,
      relativeCrop: null,
    };
  }

  return {
    backend: "desktop-region-window",
    rect: windowInfo.window_rect,
    relativeCrop: null,
  };
}

function buildDesktopRegionCaptureArgs(mp4Path, input, rect) {
  return [
    "-y",
    "-f",
    "gdigrab",
    "-draw_mouse",
    "1",
    "-framerate",
    String(input.capture_fps),
    "-offset_x",
    String(rect.left),
    "-offset_y",
    String(rect.top),
    "-video_size",
    `${rect.width}x${rect.height}`,
    "-i",
    "desktop",
    "-t",
    String(input.duration_seconds),
    "-r",
    String(input.capture_fps),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv444p",
    mp4Path,
  ];
}

function buildWindowCaptureArgs(windowInfo, mp4Path, input) {
  return [
    "-y",
    "-f",
    "gdigrab",
    "-draw_mouse",
    "1",
    "-framerate",
    String(input.capture_fps),
    "-i",
    `hwnd=0x${Number(windowInfo.hwnd).toString(16)}`,
    "-t",
    String(input.duration_seconds),
    "-r",
    String(input.capture_fps),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv444p",
    mp4Path,
  ];
}

function buildCropArgs(sourcePath, outputPath, crop, targetRect, captureFps) {
  return [
    "-y",
    "-i",
    sourcePath,
    "-vf",
    `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top},scale=${targetRect.width}:${targetRect.height}`,
    "-r",
    String(captureFps),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv444p",
    outputPath,
  ];
}

function computeScaledClientCrop(windowInfo, rawVideoStream) {
  ensureRect(windowInfo.window_rect, "window_rect");
  ensureRect(windowInfo.client_rect, "client_rect");

  if (!rawVideoStream?.width || !rawVideoStream?.height) {
    throw new RecorderError("Missing raw video dimensions for client-area crop.");
  }

  const windowRect = windowInfo.window_rect;
  const clientRect = windowInfo.client_rect;
  const scaleX = rawVideoStream.width / windowRect.width;
  const scaleY = rawVideoStream.height / windowRect.height;

  const left = Math.max(0, Math.round((clientRect.left - windowRect.left) * scaleX));
  const top = Math.max(0, Math.round((clientRect.top - windowRect.top) * scaleY));
  const right = Math.min(rawVideoStream.width, Math.round((clientRect.right - windowRect.left) * scaleX));
  const bottom = Math.min(rawVideoStream.height, Math.round((clientRect.bottom - windowRect.top) * scaleY));
  const width = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0) {
    throw new RecorderError(
      `Computed client crop is invalid. left=${left}, top=${top}, right=${right}, bottom=${bottom}, raw=${rawVideoStream.width}x${rawVideoStream.height}`,
    );
  }

  return {
    left,
    top,
    width,
    height,
    scale_x: scaleX,
    scale_y: scaleY,
  };
}

async function captureVideo(windowInfo, sessionDir, input, geometry) {
  const mp4Path = path.join(sessionDir, "capture.mp4");

  if (geometry.backend === "desktop-region-window") {
    const desktopCaptureResult = await runProcess("ffmpeg", buildDesktopRegionCaptureArgs(mp4Path, input, geometry.rect), {
      cwd: sessionDir,
    });

    if (desktopCaptureResult.code !== 0) {
      throw new RecorderError(
        `ffmpeg capture failed for backend ${geometry.backend}: ${desktopCaptureResult.stderr.trim() || desktopCaptureResult.stdout.trim()}`,
      );
    }

    return {
      mp4Path,
      backend: geometry.backend,
      relativeCrop: null,
      rawVideoStream: null,
    };
  }

  const rawMp4Path = path.join(sessionDir, "capture-raw.mp4");
  const rawCaptureResult = await runProcess("ffmpeg", buildWindowCaptureArgs(windowInfo, rawMp4Path, input), {
    cwd: sessionDir,
  });

  if (rawCaptureResult.code !== 0) {
    throw new RecorderError(
      `ffmpeg capture failed for backend ${geometry.backend}: ${rawCaptureResult.stderr.trim() || rawCaptureResult.stdout.trim()}`,
    );
  }

  const rawProbe = await probeVideo(rawMp4Path);
  const rawVideoStream = getPrimaryVideoStream(rawProbe);
  const scaledCrop = computeScaledClientCrop(windowInfo, rawVideoStream);
  const cropResult = await runProcess(
    "ffmpeg",
    buildCropArgs(rawMp4Path, mp4Path, scaledCrop, geometry.rect, input.capture_fps),
    {
      cwd: sessionDir,
    },
  );

  if (cropResult.code !== 0) {
    throw new RecorderError(
      `ffmpeg crop failed for backend ${geometry.backend}: ${cropResult.stderr.trim() || cropResult.stdout.trim()}`,
    );
  }

  await maybeDeleteFile(rawMp4Path);

  return {
    mp4Path,
    backend: geometry.backend,
    relativeCrop: scaledCrop,
    rawVideoStream,
  };
}

async function probeVideo(mp4Path) {
  const result = await runProcess("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,avg_frame_rate:format=duration",
    "-of",
    "json",
    mp4Path,
  ]);

  if (result.code !== 0) {
    throw new RecorderError(`ffprobe failed for ${mp4Path}. stderr: ${result.stderr.trim()}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new RecorderError(`Failed to parse ffprobe output for ${mp4Path}. ${error.message}`);
  }
}

async function extractFrames(mp4Path, framesDir, frameSampleFps, expectedWidth, expectedHeight) {
  const result = await runProcess("ffmpeg", [
    "-y",
    "-i",
    mp4Path,
    "-vf",
    `fps=${frameSampleFps}`,
    "-start_number",
    "0",
    path.join(framesDir, "frame-%04d.png"),
  ]);

  if (result.code !== 0) {
    throw new RecorderError(`ffmpeg frame extraction failed. stderr: ${result.stderr.trim()}`);
  }

  const files = (await fs.readdir(framesDir))
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new RecorderError("Frame extraction produced no PNG files.");
  }

  return files.map((fileName, index) => ({
    index,
    timestamp_seconds: Number((index / frameSampleFps).toFixed(3)),
    path: path.join(framesDir, fileName),
    width: expectedWidth,
    height: expectedHeight,
  }));
}

async function resolveTargetWindow(input) {
  let launchMetadata = null;
  let targetWindow = null;

  if (input.launch_command) {
    launchMetadata = await launchTargetProcess(input);
    targetWindow = await waitForWindow(input, launchMetadata);
  } else {
    const windows = await listVisibleWindows();
    targetWindow = chooseUniqueWindow(
      windows,
      {
        pid: input.pid,
        process_name: input.process_name,
        window_title_contains: input.window_title_contains,
      },
      "attach selector",
    );
  }

  const activation = await focusWindow(targetWindow.hwnd);

  if (input.settle_seconds > 0) {
    await sleep(input.settle_seconds * 1000);
  }

  const windows = await listVisibleWindows();
  const refreshedWindow = chooseUniqueWindow(
    windows,
    {
      hwnd: targetWindow.hwnd,
    },
    "resolved hwnd",
  );

  return {
    activation,
    launchMetadata,
    targetWindow: refreshedWindow,
  };
}

async function maybeDeleteFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function listAppWindows(input = {}) {
  const windows = await listVisibleWindows();
  const filteredWindows = filterWindows(windows, input);

  return {
    count: filteredWindows.length,
    windows: filteredWindows.map((windowInfo) => summarizeWindow(windowInfo)),
  };
}

export async function recordWindowCapture(rawInput) {
  const input = normalizeRecordInput(rawInput);
  await ensureBinary("ffmpeg");
  await ensureBinary("ffprobe");

  const session = await createSessionDirectory();
  const { activation, launchMetadata, targetWindow } = await resolveTargetWindow(input);
  const geometry = getCaptureGeometry(targetWindow, input.client_area_only);
  const inputRecorder = await startInputRecorder(session.sessionDir, input);
  await sleep(INPUT_RECORDER_STARTUP_GRACE_MS);
  const captureStartedAtUnixMs = Date.now();
  const capture = await captureVideo(targetWindow, session.sessionDir, input, geometry);
  const captureFinishedAtUnixMs = Date.now();
  const ffprobe = await probeVideo(capture.mp4Path);
  const primaryVideoStream = getPrimaryVideoStream(ffprobe);
  const frames = await extractFrames(
    capture.mp4Path,
    session.framesDir,
    input.frame_sample_fps,
    primaryVideoStream?.width ?? geometry.rect.width,
    primaryVideoStream?.height ?? geometry.rect.height,
  );
  const inputEvents = await finalizeInputRecorder(
    inputRecorder,
    session.sessionDir,
    targetWindow,
    geometry.rect,
    captureStartedAtUnixMs,
    captureFinishedAtUnixMs,
  );

  const manifestPath = path.join(session.sessionDir, "manifest.json");
  const payload = {
    session_id: session.sessionId,
    session_directory: session.sessionDir,
    recorded_at: new Date().toISOString(),
    capture_backend: capture.backend,
    target_window: summarizeWindow(targetWindow),
    launch: launchMetadata,
    options: {
      duration_seconds: input.duration_seconds,
      settle_seconds: input.settle_seconds,
      capture_fps: input.capture_fps,
      frame_sample_fps: input.frame_sample_fps,
      client_area_only: input.client_area_only,
      preserve_mp4: input.preserve_mp4,
    },
    capture_rect: geometry.rect,
    relative_crop: capture.relativeCrop ?? geometry.relativeCrop,
    mp4_path: input.preserve_mp4 ? capture.mp4Path : null,
    manifest_path: manifestPath,
    input_events_path: inputRecorder.inputEventsPath,
    input_event_count: inputEvents.event_count,
    capture_started_at: new Date(captureStartedAtUnixMs).toISOString(),
    capture_finished_at: new Date(captureFinishedAtUnixMs).toISOString(),
    ffprobe,
    debug: {
      selected_backend: capture.backend,
      window_activation: activation,
      window_rect: targetWindow.window_rect,
      client_rect: targetWindow.client_rect,
      raw_video_stream: capture.rawVideoStream,
      video_stream: primaryVideoStream,
      input_recorder: {
        started_at_unix_ms: inputEvents.recorder_started_at_unix_ms,
        finished_at_unix_ms: inputEvents.recorder_finished_at_unix_ms,
        duration_ms: inputEvents.recorder_duration_ms,
      },
    },
    frames,
  };

  await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2));

  if (!input.preserve_mp4) {
    await maybeDeleteFile(capture.mp4Path);
  }

  return payload;
}

const server = new McpServer({
  name: "app-window-recorder",
  version: "0.1.0",
});

server.registerTool(
  "list_app_windows",
  {
    description: "List visible top-level Windows app windows that can be attached for recording.",
    inputSchema: {
      process_name: z.string().optional(),
      window_title_contains: z.string().optional(),
    },
  },
  async (input) => {
    try {
      return buildToolResult(await listAppWindows(input));
    } catch (error) {
      throw new Error(error.message);
    }
  },
);

server.registerTool(
  "record_app_window",
  {
    description:
      "Launch or attach to a Windows app window, record it for a bounded duration, extract PNG frames, log mouse and keyboard events with timestamps, and return absolute artifact paths.",
    inputSchema: {
      duration_seconds: z.number().int().min(1).max(MAX_DURATION_SECONDS),
      launch_command: z.string().optional(),
      launch_args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      pid: z.number().int().optional(),
      process_name: z.string().optional(),
      window_title_contains: z.string().optional(),
      settle_seconds: z.number().min(0).max(10).default(DEFAULT_SETTLE_SECONDS),
      capture_fps: z.number().int().min(1).max(60).default(DEFAULT_CAPTURE_FPS),
      frame_sample_fps: z.number().int().min(1).max(10).default(DEFAULT_FRAME_SAMPLE_FPS),
      client_area_only: z.boolean().default(true),
      preserve_mp4: z.boolean().default(true),
    },
  },
  async (input) => {
    try {
      return buildToolResult(await recordWindowCapture(input));
    } catch (error) {
      throw new Error(error.message);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
