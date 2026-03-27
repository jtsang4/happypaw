#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'codex-binary.json');

let cachedConfig;

export function getPinnedCodexBinaryConfig() {
  if (!cachedConfig) {
    cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  return cachedConfig;
}

export function ensureRepoPinnedCodexBinary(options = {}) {
  const logger = options.logger ?? (() => {});
  const resolved = resolveRepoPinnedCodexBinary(options);
  if (fs.existsSync(resolved.executablePath)) {
    ensureExecutablePermissions(resolved.executablePath);
    writePinnedCodexMetadata(resolved);
    logger(
      `Reusing repo-managed pinned Codex at ${resolved.executablePath} (${resolved.version})`,
    );
    return { ...resolved, downloaded: false };
  }

  fs.mkdirSync(resolved.cacheDir, { recursive: true });
  const archivePath = path.join(resolved.cacheDir, resolved.assetName);
  logger(
    `Downloading repo-managed pinned Codex ${resolved.version} from ${resolved.assetUrl} to ${archivePath}`,
  );
  downloadArchive(resolved.assetUrl, archivePath);
  try {
    extractArchive(
      archivePath,
      resolved.cacheDir,
      resolved.executableName,
      resolved.executablePath,
    );
    writePinnedCodexMetadata(resolved);
    logger(`Prepared repo-managed pinned Codex at ${resolved.executablePath}`);
    return { ...resolved, downloaded: true };
  } catch (error) {
    fs.rmSync(resolved.executablePath, { force: true });
    throw error;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

export function resolveRepoPinnedCodexBinary(options = {}) {
  const config = getPinnedCodexBinaryConfig();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const targetTriple = resolveTargetTriple(
    platform,
    arch,
  );
  const assetName = `${config.assetBasename}-${targetTriple}.tar.gz`;
  const cacheRoot = path.resolve(REPO_ROOT, config.repoCacheDir);
  const cacheDir = path.join(
    cacheRoot,
    config.version,
    targetTriple,
  );
  return {
    assetName,
    assetUrl: `https://github.com/${config.releaseRepo}/releases/download/${config.releaseTag}/${assetName}`,
    cacheDir,
    executableName: config.assetBasename,
    executablePath: path.join(cacheDir, config.assetBasename),
    metadataPath: path.join(cacheDir, 'metadata.json'),
    version: config.version,
    releaseTag: config.releaseTag,
    releaseRepo: config.releaseRepo,
  };
}

function resolveTargetTriple(platform, arch) {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'aarch64-apple-darwin';
    if (arch === 'x64') return 'x86_64-apple-darwin';
  }

  if (platform === 'linux') {
    const libc = detectLinuxLibc(platform);
    if (arch === 'arm64') {
      return libc === 'musl'
        ? 'aarch64-unknown-linux-musl'
        : 'aarch64-unknown-linux-gnu';
    }
    if (arch === 'x64') {
      return libc === 'musl'
        ? 'x86_64-unknown-linux-musl'
        : 'x86_64-unknown-linux-gnu';
    }
  }

  throw new Error(
    `Unsupported repo-managed pinned Codex platform/arch: ${platform}/${arch}`,
  );
}

function detectLinuxLibc(platform) {
  if (platform !== 'linux') return 'gnu';

  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) {
    return 'gnu';
  }

  try {
    const ldd = execFileSync('ldd', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (ldd.toLowerCase().includes('musl')) return 'musl';
  } catch {
    /* ignore */
  }

  const muslCandidates = ['/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1'];
  if (muslCandidates.some((candidate) => fs.existsSync(candidate))) {
    return 'musl';
  }

  return 'gnu';
}

function downloadArchive(url, archivePath) {
  execFileSync('curl', ['-fsSL', '-o', archivePath, url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function extractArchive(archivePath, destinationDir, executableName, executablePath) {
  const extractDir = fs.mkdtempSync(
    path.join(destinationDir, `${executableName}-extract-`),
  );
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entries = fs
      .readdirSync(extractDir)
      .filter((entry) => !entry.startsWith('.'));
    if (entries.length !== 1) {
      throw new Error(`Unexpected Codex archive layout: ${entries.join(', ')}`);
    }
    fs.copyFileSync(path.join(extractDir, entries[0]), executablePath);
    ensureExecutablePermissions(executablePath);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function ensureExecutablePermissions(filePath) {
  const currentMode = fs.statSync(filePath).mode;
  const desiredMode = currentMode | 0o755;
  if (currentMode !== desiredMode) {
    fs.chmodSync(filePath, desiredMode);
  }
}

function writePinnedCodexMetadata(resolved) {
  fs.writeFileSync(
    resolved.metadataPath,
    `${JSON.stringify(
      {
        executablePath: resolved.executablePath,
        assetName: resolved.assetName,
        assetUrl: resolved.assetUrl,
        version: resolved.version,
        releaseTag: resolved.releaseTag,
        releaseRepo: resolved.releaseRepo,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ensureRepoPinnedCodexBinary({
    logger: (message) => console.error(message),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        executablePath: result.executablePath,
        assetName: result.assetName,
        assetUrl: result.assetUrl,
        version: result.version,
        releaseTag: result.releaseTag,
        releaseRepo: result.releaseRepo,
        cacheDir: result.cacheDir,
        downloaded: result.downloaded,
        hostname: os.hostname(),
      },
      null,
      2,
    )}\n`,
  );
}
