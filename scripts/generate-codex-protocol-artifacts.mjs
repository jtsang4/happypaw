#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const artifactRoot = path.join(repoRoot, 'generated', 'codex-app-server-protocol');
const tsArtifactDir = path.join(artifactRoot, 'ts');
const schemaArtifactDir = path.join(artifactRoot, 'schema');
const metadataPath = path.join(artifactRoot, 'metadata.json');
const manifestPath = path.join(artifactRoot, 'manifest.json');

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--write')
    ? 'write'
    : null;

if (!mode) {
  console.error(
    'Usage: node scripts/generate-codex-protocol-artifacts.mjs --write|--check',
  );
  process.exit(1);
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'happypaw-codex-protocol-'));
const generatedTsDir = path.join(tempRoot, 'ts');
const generatedSchemaDir = path.join(tempRoot, 'schema');

try {
  const codexVersion = runCommand(['--version']).stdout.trim();
  runCommand(['app-server', 'generate-ts', '--out', generatedTsDir]);
  runCommand(['app-server', 'generate-json-schema', '--out', generatedSchemaDir]);

  const metadata = buildMetadata({
    codexVersion,
    generatedTsDir,
    generatedSchemaDir,
  });
  const manifest = buildManifest({
    codexVersion,
    generatedTsDir,
    generatedSchemaDir,
  });

  if (mode === 'write') {
    mkdirSync(artifactRoot, { recursive: true });
    rmSync(tsArtifactDir, { recursive: true, force: true });
    rmSync(schemaArtifactDir, { recursive: true, force: true });
    cpSync(generatedTsDir, tsArtifactDir, { recursive: true });
    cpSync(generatedSchemaDir, schemaArtifactDir, { recursive: true });
    writeJson(metadataPath, metadata);
    writeJson(manifestPath, manifest);
    console.log(
      `Wrote Codex protocol artifacts for ${codexVersion} to ${path.relative(
        repoRoot,
        artifactRoot,
      )}`,
    );
    process.exit(0);
  }

  const problems = [];
  if (!existsSync(tsArtifactDir) || !existsSync(schemaArtifactDir)) {
    problems.push(
      'Generated protocol artifacts are missing. Run `npm run generate:codex-protocol`.',
    );
  } else {
    problems.push(...compareDirectories(tsArtifactDir, generatedTsDir, 'ts'));
    problems.push(...compareDirectories(schemaArtifactDir, generatedSchemaDir, 'schema'));
  }

  if (!existsSync(metadataPath)) {
    problems.push('Missing generated/codex-app-server-protocol/metadata.json.');
  } else if (readFileSync(metadataPath, 'utf8') !== serializeJson(metadata)) {
    problems.push('metadata.json does not match the installed Codex CLI output.');
  }

  if (!existsSync(manifestPath)) {
    problems.push('Missing generated/codex-app-server-protocol/manifest.json.');
  } else if (readFileSync(manifestPath, 'utf8') !== serializeJson(manifest)) {
    problems.push('manifest.json does not match the installed Codex CLI output.');
  }

  if (problems.length > 0) {
    console.error('Codex protocol artifacts are out of date:');
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    console.error('Run `npm run generate:codex-protocol` to refresh them.');
    process.exit(1);
  }

  console.log(
    `Codex protocol artifacts match installed CLI (${codexVersion}) in ${path.relative(
      repoRoot,
      artifactRoot,
    )}`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function runCommand(args) {
  const result = spawnSync('codex', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const detail = stderr || stdout || `exit code ${result.status}`;
    throw new Error(`codex ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

function buildMetadata({ codexVersion, generatedTsDir, generatedSchemaDir }) {
  return {
    generator: 'codex app-server',
    codexCliVersion: codexVersion,
    commands: {
      generateTs: 'codex app-server generate-ts --out <DIR>',
      generateJsonSchema: 'codex app-server generate-json-schema --out <DIR>',
    },
    artifacts: {
      tsDirectory: toRepoRelative(tsArtifactDir),
      schemaDirectory: toRepoRelative(schemaArtifactDir),
      metadataFile: toRepoRelative(metadataPath),
      manifestFile: toRepoRelative(manifestPath),
      tsFileCount: listRelativeFiles(generatedTsDir).length,
      schemaFileCount: listRelativeFiles(generatedSchemaDir).length,
      tsSha256: hashDirectory(generatedTsDir),
      schemaSha256: hashDirectory(generatedSchemaDir),
    },
  };
}

function buildManifest({ codexVersion, generatedTsDir, generatedSchemaDir }) {
  const clientRequestFile = path.join(generatedTsDir, 'ClientRequest.ts');
  const serverNotificationFile = path.join(generatedTsDir, 'ServerNotification.ts');
  const schemaBundleFile = path.join(
    generatedSchemaDir,
    'codex_app_server_protocol.v2.schemas.json',
  );

  return {
    codexCliVersion: codexVersion,
    requestMethods: extractMethods(readFileSync(clientRequestFile, 'utf8')),
    notificationMethods: extractMethods(readFileSync(serverNotificationFile, 'utf8')),
    schemaBundle: toRepoRelative(path.join(schemaArtifactDir, 'codex_app_server_protocol.v2.schemas.json')),
    schemaTitle: JSON.parse(readFileSync(schemaBundleFile, 'utf8')).title,
  };
}

function extractMethods(source) {
  const methods = [];
  const seen = new Set();
  const pattern = /"method": "([^"]+)"/g;
  for (const match of source.matchAll(pattern)) {
    const method = match[1];
    if (!seen.has(method)) {
      seen.add(method);
      methods.push(method);
    }
  }
  return methods;
}

function compareDirectories(expectedDir, actualDir, label) {
  const expectedFiles = listRelativeFiles(expectedDir);
  const actualFiles = listRelativeFiles(actualDir);
  const problems = [];
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);

  for (const file of expectedFiles) {
    if (!actualSet.has(file)) {
      problems.push(`${label}: missing file ${file}`);
      continue;
    }
    const expectedBuffer = normalizeFileContent(path.join(expectedDir, file));
    const actualBuffer = normalizeFileContent(path.join(actualDir, file));
    if (!expectedBuffer.equals(actualBuffer)) {
      problems.push(`${label}: content differs for ${file}`);
    }
  }

  for (const file of actualFiles) {
    if (!expectedSet.has(file)) {
      problems.push(`${label}: unexpected file ${file}`);
    }
  }

  return problems.slice(0, 40);
}

function listRelativeFiles(rootDir) {
  const files = [];
  walk(rootDir, '');
  return files.sort();

  function walk(currentDir, relativePrefix) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const relativePath = relativePrefix
        ? path.posix.join(relativePrefix, entry.name)
        : entry.name;
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
}

function hashDirectory(rootDir) {
  const hash = createHash('sha256');
  for (const relativeFile of listRelativeFiles(rootDir)) {
    hash.update(relativeFile);
    hash.update('\0');
    hash.update(normalizeFileContent(path.join(rootDir, relativeFile)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function normalizeFileContent(filePath) {
  const raw = readFileSync(filePath);
  if (!filePath.endsWith('.json')) {
    return raw;
  }

  const parsed = JSON.parse(raw.toString('utf8'));
  return Buffer.from(JSON.stringify(sortJsonValue(parsed)));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, serializeJson(value));
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toRepoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join(path.posix.sep);
}
