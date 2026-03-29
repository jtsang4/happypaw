import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HAPPYPAW_CODEX_EXECUTABLE_ENV = 'HAPPYPAW_CODEX_EXECUTABLE';

type LinuxLibc = 'gnu' | 'musl';

export interface PinnedCodexBinaryConfig {
  version: string;
  releaseTag: string;
  releaseRepo: string;
  assetBasename: string;
  repoCacheDir: string;
  hostCacheDir: string;
  containerExecutablePath: string;
}

export interface ResolvedPinnedCodexBinary {
  assetName: string;
  assetUrl: string;
  cacheDir: string;
  cacheMetadataPath: string;
  executableName: string;
  executablePath: string;
  platformKey: string;
  releaseRepo: string;
  releaseTag: string;
  version: string;
}

export interface EnsuredPinnedCodexBinary extends ResolvedPinnedCodexBinary {
  downloaded: boolean;
}

interface EnsurePinnedCodexBinaryOptions {
  cacheRoot?: string;
  downloadArchive?: (url: string, archivePath: string) => void;
  extractArchive?: (
    archivePath: string,
    destinationDir: string,
    executableName: string,
    executablePath: string,
  ) => void;
  logger?: (message: string) => void;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');
const PINNED_CODEX_CONFIG_PATH = path.join(
  REPO_ROOT,
  'config',
  'codex-binary.json',
);

let cachedConfig: PinnedCodexBinaryConfig | null = null;

export function getPinnedCodexBinaryConfig(): PinnedCodexBinaryConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = JSON.parse(
    fs.readFileSync(PINNED_CODEX_CONFIG_PATH, 'utf8'),
  ) as PinnedCodexBinaryConfig;
  return cachedConfig;
}

export function getPinnedCodexContainerExecutablePath(): string {
  return getPinnedCodexBinaryConfig().containerExecutablePath;
}

export function getPinnedCodexRepoCacheRoot(): string {
  const config = getPinnedCodexBinaryConfig();
  return path.resolve(REPO_ROOT, config.repoCacheDir);
}

export function getPinnedCodexHostCacheRoot(): string {
  const config = getPinnedCodexBinaryConfig();
  return path.resolve(REPO_ROOT, config.hostCacheDir);
}

export function resolvePinnedCodexHostBinary(
  options: Pick<
    EnsurePinnedCodexBinaryOptions,
    'arch' | 'cacheRoot' | 'platform'
  > = {},
): ResolvedPinnedCodexBinary {
  const config = getPinnedCodexBinaryConfig();
  const asset = resolvePinnedCodexAsset(options.platform, options.arch);
  const cacheRoot =
    options.cacheRoot ?? path.resolve(REPO_ROOT, config.hostCacheDir);
  const cacheDir = path.join(cacheRoot, config.version, asset.platformKey);
  const executablePath = path.join(cacheDir, config.assetBasename);
  return {
    ...asset,
    cacheDir,
    cacheMetadataPath: path.join(cacheDir, 'metadata.json'),
    executableName: config.assetBasename,
    executablePath,
    releaseRepo: config.releaseRepo,
    releaseTag: config.releaseTag,
    version: config.version,
  };
}

export function ensurePinnedCodexHostBinary(
  options: EnsurePinnedCodexBinaryOptions = {},
): EnsuredPinnedCodexBinary {
  const logger = options.logger ?? (() => {});
  const resolved = resolvePinnedCodexHostBinary(options);
  if (fs.existsSync(resolved.executablePath)) {
    ensureExecutablePermissions(resolved.executablePath);
    writePinnedCodexMetadata(resolved);
    logger(
      `Reusing pinned Codex host cache at ${resolved.executablePath} (${resolved.version})`,
    );
    return { ...resolved, downloaded: false };
  }

  fs.mkdirSync(resolved.cacheDir, { recursive: true });
  const archivePath = path.join(resolved.cacheDir, resolved.assetName);
  try {
    logger(
      `Downloading pinned Codex ${resolved.version} from ${resolved.assetUrl} to ${archivePath}`,
    );
    (options.downloadArchive ?? downloadPinnedCodexArchive)(
      resolved.assetUrl,
      archivePath,
    );
    (options.extractArchive ?? extractPinnedCodexArchive)(
      archivePath,
      resolved.cacheDir,
      resolved.executableName,
      resolved.executablePath,
    );
    writePinnedCodexMetadata(resolved);
    logger(
      `Prepared pinned Codex host executable at ${resolved.executablePath}`,
    );
    return { ...resolved, downloaded: true };
  } catch (error) {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(resolved.executablePath, { force: true });
    throw error;
  }
}

export function defaultHostPinnedCodexCacheRoot(): string {
  return getPinnedCodexHostCacheRoot();
}

export function resolveManagedCodexExecutablePath(
  env: NodeJS.ProcessEnv,
): string {
  const configured = env[HAPPYPAW_CODEX_EXECUTABLE_ENV]?.trim();
  if (!configured) {
    throw new Error(
      `Missing ${HAPPYPAW_CODEX_EXECUTABLE_ENV}; HappyPaw only supports managed pinned Codex executables.`,
    );
  }
  return configured;
}

function resolvePinnedCodexAsset(
  platform = process.platform,
  arch = process.arch,
): Pick<ResolvedPinnedCodexBinary, 'assetName' | 'assetUrl' | 'platformKey'> {
  const config = getPinnedCodexBinaryConfig();
  const triple = resolvePinnedCodexTargetTriple(platform, arch);
  const assetName = `${config.assetBasename}-${triple}.tar.gz`;
  return {
    assetName,
    assetUrl: `https://github.com/${config.releaseRepo}/releases/download/${config.releaseTag}/${assetName}`,
    platformKey: triple,
  };
}

function resolvePinnedCodexTargetTriple(
  platform: NodeJS.Platform,
  arch: string,
): string {
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
    `Unsupported pinned Codex platform/arch combination: ${platform}/${arch}`,
  );
}

function detectLinuxLibc(platform: NodeJS.Platform): LinuxLibc {
  if (platform !== 'linux') {
    return 'gnu';
  }

  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
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

  try {
    const libcCandidates = [
      '/lib/ld-musl-x86_64.so.1',
      '/lib/ld-musl-aarch64.so.1',
      '/usr/glibc-compat/lib/ld-linux-x86-64.so.2',
    ];
    if (libcCandidates.some((candidate) => fs.existsSync(candidate))) {
      return fs.existsSync('/usr/glibc-compat/lib/ld-linux-x86-64.so.2')
        ? 'gnu'
        : 'musl';
    }
  } catch {
    /* ignore */
  }

  return 'gnu';
}

function downloadPinnedCodexArchive(url: string, archivePath: string): void {
  execFileSync('curl', ['-fsSL', '-o', archivePath, url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function extractPinnedCodexArchive(
  archivePath: string,
  destinationDir: string,
  executableName: string,
  executablePath: string,
): void {
  const extractDir = fs.mkdtempSync(
    path.join(destinationDir, `${executableName}-extract-`),
  );
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const extractedEntries = fs
      .readdirSync(extractDir)
      .filter((entry) => !entry.startsWith('.'));
    if (extractedEntries.length !== 1) {
      throw new Error(
        `Unexpected pinned Codex archive contents: ${extractedEntries.join(', ')}`,
      );
    }
    const extractedPath = path.join(extractDir, extractedEntries[0]);
    fs.copyFileSync(extractedPath, executablePath);
    ensureExecutablePermissions(executablePath);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function ensureExecutablePermissions(filePath: string): void {
  const currentMode = fs.statSync(filePath).mode;
  const desiredMode = currentMode | 0o755;
  if (currentMode !== desiredMode) {
    fs.chmodSync(filePath, desiredMode);
  }
}

function writePinnedCodexMetadata(resolved: ResolvedPinnedCodexBinary): void {
  const metadata = {
    executablePath: resolved.executablePath,
    assetName: resolved.assetName,
    assetUrl: resolved.assetUrl,
    version: resolved.version,
    releaseTag: resolved.releaseTag,
    releaseRepo: resolved.releaseRepo,
    platformKey: resolved.platformKey,
    hostname: os.hostname(),
  };
  fs.writeFileSync(
    resolved.cacheMetadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}
