#!/usr/bin/env node
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set([".git", ".ferrite", ".next", "dist", "build", "coverage", "node_modules"]);
const SEVERITY = { info: 0, assisted: 1, manual: 2, unsupported: 3 };

export async function scanProject(projectPath) {
  const requestedRoot = resolve(projectPath);
  const manifestPath = join(requestedRoot, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Ferrite migration scanner requires a readable package.json at ${manifestPath}: ${error.message}`);
  }
  const root = await realpath(requestedRoot);

  const files = await sourceFiles(root);
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  const signals = [];
  const add = (code, severity, file, message) => {
    if (!signals.some((signal) => signal.code === code && signal.file === file)) {
      signals.push({ code, severity, file, message });
    }
  };

  const isNext = Boolean(dependencies.next) || files.some((file) => /(^|\/)next\.config\.(?:js|mjs|cjs|ts)$/.test(file));
  const isReact = isNext || Boolean(dependencies.react) || Boolean(dependencies["react-dom"]);
  if (!isReact) add("NOT_REACT_PROJECT", "unsupported", "package.json", "No React, React DOM, or Next.js dependency was found.");
  if (isNext && files.some((file) => file.startsWith("pages/"))) add("NEXT_PAGES_ROUTER", "assisted", "pages/", "Pages Router routes need an explicit route-by-route migration plan.");

  for (const file of files) {
    const content = await readFile(join(root, file), "utf8");
    if (/\bclass\s+\w+\s+extends\s+(?:React\.)?Component\b/.test(content)) add("REACT_CLASS_COMPONENT", "manual", file, "Class component semantics need a reviewed function-component or adapter decision.");
    if (/\b(?:ReactDOM\.)?(?:render|hydrate|findDOMNode|unmountComponentAtNode)\s*\(/.test(content)) add("LEGACY_REACT_DOM", "manual", file, "Legacy React DOM APIs need an explicit runtime migration.");
    if (/from\s+["']react-router(?:-dom)?["']|require\(["']react-router/.test(content)) add("CLIENT_ROUTER", "assisted", file, "Client-router routes need an adapter or staged route migration.");
    if (/\brequire\s*\([^'"`]/.test(content) || /\bimport\s*\([^'"`]/.test(content)) add("DYNAMIC_MODULE_LOADING", "manual", file, "Dynamic module loading cannot be safely mapped by a static plan.");
    if (/\b(?:getServerSideProps|getStaticProps|getInitialProps)\b/.test(content)) add("NEXT_DATA_FUNCTION", "manual", file, "Next Pages Router data function requires a server-data and caching decision.");
    if (/from\s+["']next\/router["']/.test(content)) add("NEXT_LEGACY_ROUTER", "assisted", file, "next/router calls need a route/navigation mapping.");
    if (/from\s+["']next\/(?:image|font|script)["']/.test(content)) add("NEXT_SPECIAL_COMPONENT", "manual", file, "Next special component needs an asset, font, or script policy decision.");
  }
  if (files.some((file) => /^pages\/api\//.test(file))) add("NEXT_API_ROUTES", "manual", "pages/api/", "API routes need an explicit server/API migration boundary.");
  if (files.some((file) => /(^|\/)middleware\.(?:js|ts|mjs)$/.test(file))) add("NEXT_MIDDLEWARE", "manual", "middleware", "Middleware must be mapped to an explicit deployment/edge strategy.");
  const config = files.find((file) => /(^|\/)next\.config\.(?:js|mjs|cjs|ts)$/.test(file));
  if (config) add("NEXT_CONFIG", "manual", config, "Next configuration requires a reviewed Ferrite/deployment equivalent.");

  const highest = signals.reduce((maximum, signal) => Math.max(maximum, SEVERITY[signal.severity]), 0);
  const tier = ["TIER_1_STRUCTURAL", "TIER_2_ASSISTED", "TIER_3_MANUAL_REVIEW", "TIER_4_UNSUPPORTED"][highest];
  const blockers = signals.filter((signal) => signal.severity !== "info");
  const framework = isNext ? "next" : isReact ? "react" : "unknown";
  return {
    schemaVersion: 1,
    tool: "ferrite-migrate scan",
    mode: "read-only-dry-run",
    project: { root, packageName: manifest.name ?? null, framework, filesScanned: files.length },
    compatibility: {
      tier,
      automaticMigration: false,
      rationale: tier === "TIER_1_STRUCTURAL"
        ? "No known static blocker was detected; this remains a candidate, not a guarantee."
        : "Detected items require an adapter or manual review before any transform.",
    },
    observations: signals.sort((left, right) => left.file.localeCompare(right.file) || left.code.localeCompare(right.code)),
    manualBlockers: blockers.filter((signal) => signal.severity === "manual" || signal.severity === "unsupported"),
    dryRunPlan: [
      "Preserve the source revision and inventory dependencies, routes, assets, styles, and environment-variable names.",
      "Create an isolated worktree only after every manual blocker has an owner and accepted mapping.",
      "Apply narrowly scoped AST codemods plus adapter plugins; never rewrite unclassified dynamic code.",
      "Verify install, typecheck, unit/integration tests, production build, browser parity, and a bounded performance comparison.",
      "Generate a focused PR with exact evidence, manual annotations, and rollback instructions; retain the original project unchanged.",
    ],
  };
}

async function sourceFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIP_DIRECTORIES.has(entry.name) ? [] : sourceFiles(root, path);
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) return [];
    return [relative(root, path)];
  }));
  return nested.flat().sort();
}

export async function run(argv) {
  const args = [...argv];
  const projectFlag = args.indexOf("--project");
  if (projectFlag === -1 || !args[projectFlag + 1]) throw new Error("Usage: scan.mjs --project <path> [--output <plan.json>]");
  const report = await scanProject(args[projectFlag + 1]);
  const outputFlag = args.indexOf("--output");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputFlag !== -1) {
    if (!args[outputFlag + 1]) throw new Error("--output requires a path");
    const output = resolve(args[outputFlag + 1]);
    await rejectProjectOutput(report.project.root, output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json, "utf8");
  } else {
    process.stdout.write(json);
  }
  return report;
}

async function rejectProjectOutput(projectRoot, output) {
  const canonicalProjectRoot = await realpath(projectRoot);
  const canonicalOutput = await canonicalPath(output);
  const pathFromProject = relative(canonicalProjectRoot, canonicalOutput);
  if (pathFromProject === "" || (!pathFromProject.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && pathFromProject !== ".." && !isAbsolute(pathFromProject))) {
    throw new Error(`Refusing to write --output inside scanned project: ${output}. Choose a path outside ${canonicalProjectRoot}.`);
  }
}

async function canonicalPath(path) {
  let candidate = resolve(path);
  const missing = [];
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
