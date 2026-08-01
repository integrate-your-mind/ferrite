import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const systemBrowserCandidates = (platform, env) => {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (platform === "win32") {
    return [
      env.PROGRAMFILES ? join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : null,
      env["PROGRAMFILES(X86)"] ? join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : null,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
      env.PROGRAMFILES ? join(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : null,
    ];
  }
  if (platform === "linux") {
    return [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ];
  }
  return [];
};

export function browserExecutableCandidates({
  env = process.env,
  platform = process.platform,
  playwrightExecutablePath,
} = {}) {
  const configured = env.FERRITE_BROWSER_EXECUTABLE?.trim();
  if (configured) return { candidates: [configured], configured: true };

  return {
    candidates: [playwrightExecutablePath, ...systemBrowserCandidates(platform, env)]
      .filter((candidate) => typeof candidate === "string" && candidate.length > 0)
      .filter((candidate, index, all) => all.indexOf(candidate) === index),
    configured: false,
  };
}

export function cargoTargetRoot({
  env = process.env,
  repoRoot,
} = {}) {
  const configured = env.CARGO_TARGET_DIR;
  if (!configured) {
    return join(repoRoot, "target");
  }
  return isAbsolute(configured) ? configured : resolve(repoRoot, configured);
}

export async function launchVerifiedBrowser({
  chromium,
  candidates,
  configured = false,
  platform = process.platform,
  statFile = stat,
  accessFile = access,
}) {
  const failures = [];
  for (const executablePath of candidates) {
    let browser;
    try {
      const metadata = await statFile(executablePath);
      if (!metadata.isFile()) throw new Error("path is not a regular file");
      if (platform !== "win32") await accessFile(executablePath, constants.X_OK);
      browser = await chromium.launch({ executablePath, headless: true });
      const version = browser.version();
      if (typeof version !== "string" || version.trim().length === 0) {
        throw new Error("browser did not report a version");
      }
      return { browser, executablePath, version };
    } catch (error) {
      if (browser) {
        try {
          await browser.close();
        } catch {
          // The launch error remains the useful selection failure.
        }
      }
      failures.push(new Error(`${executablePath}: ${error instanceof Error ? error.message : String(error)}`));
      if (configured) break;
    }
  }

  const guidance = configured
    ? "FERRITE_BROWSER_EXECUTABLE did not identify a launchable Chromium browser"
    : "No launchable Chromium browser was found; set FERRITE_BROWSER_EXECUTABLE or install Chromium";
  throw new AggregateError(failures, guidance);
}

export async function withVerifiedBrowser(launchOptions, operation) {
  const browserProof = await launchVerifiedBrowser(launchOptions);
  let result;
  let operationError;
  try {
    result = await operation(browserProof);
  } catch (error) {
    operationError = error;
  }

  try {
    await browserProof.browser.close();
  } catch (error) {
    if (operationError) {
      throw new AggregateError(
        [operationError, error],
        "demo browser proof and shared browser cleanup failed",
      );
    }
    throw error;
  }

  if (operationError) throw operationError;
  return result;
}

export async function listArtifactFiles(root, relativeRoot = "") {
  const directory = relativeRoot ? join(root, ...relativeRoot.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listArtifactFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`artifact contains unsupported entry: ${relative}`);
    }
  }
  return files;
}

export function expectedArtifactFiles(fileRecords) {
  return [
    "ferrite-build.json",
    "ferrite-server.json",
    ...fileRecords.map((file) => file.path),
  ].sort();
}
