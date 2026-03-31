#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '..');
export const sourceDir = path.join(
  repoRoot,
  'generated',
  'codex-app-server-protocol',
  'ts',
);
export const targetDir = path.join(
  repoRoot,
  'container',
  'agent-runner',
  'src',
  'generated',
  'codex-app-server-protocol',
);

export function syncCodexProtocolAgentRunnerMirror({
  sourceRoot = sourceDir,
  targetRoot = targetDir,
} = {}) {
  const transformedFiles = new Set();

  copyDirectory(sourceRoot);
  pruneRemovedTargets(targetRoot);

  function copyDirectory(currentSourceDir) {
    const relativeDir = path.relative(sourceRoot, currentSourceDir);
    const currentTargetDir =
      relativeDir === '' ? targetRoot : path.join(targetRoot, relativeDir);
    mkdirSync(currentTargetDir, { recursive: true });

    for (const entry of readdirSync(currentSourceDir, { withFileTypes: true })) {
      const sourcePath = path.join(currentSourceDir, entry.name);
      const relativePath =
        relativeDir === ''
          ? entry.name
          : path.posix.join(
              relativeDir.split(path.sep).join(path.posix.sep),
              entry.name,
            );
      const targetPath = path.join(currentTargetDir, entry.name);

      if (entry.isDirectory()) {
        copyDirectory(sourcePath);
        continue;
      }

      if (!entry.isFile()) continue;

      transformedFiles.add(path.normalize(targetPath));

      if (entry.name.endsWith('.ts')) {
        const transformed = addJsExtensions(sourcePath, readFileSync(sourcePath, 'utf8'));
        if (!existsSync(targetPath) || readFileSync(targetPath, 'utf8') !== transformed) {
          writeFileSync(targetPath, transformed);
        }
        continue;
      }

      cpSync(sourcePath, targetPath, { force: true });
    }
  }

  function pruneRemovedTargets(currentTargetDir) {
    if (!existsSync(currentTargetDir)) return;
    for (const entry of readdirSync(currentTargetDir, { withFileTypes: true })) {
      const targetPath = path.join(currentTargetDir, entry.name);
      if (entry.isDirectory()) {
        pruneRemovedTargets(targetPath);
        const children = readdirSync(targetPath);
        if (children.length === 0) {
          rmSync(targetPath, { recursive: true, force: true });
        }
        continue;
      }

      if (!transformedFiles.has(path.normalize(targetPath))) {
        rmSync(targetPath, { force: true });
      }
    }
  }
}

export function compareCodexProtocolAgentRunnerMirror({
  sourceRoot = sourceDir,
  targetRoot = targetDir,
} = {}) {
  const sourceFiles = listRelativeFiles(sourceRoot);
  const targetFiles = existsSync(targetRoot) ? listRelativeFiles(targetRoot) : [];
  const problems = [];
  const targetSet = new Set(targetFiles);

  for (const relativeFile of sourceFiles) {
    const sourcePath = path.join(sourceRoot, relativeFile);
    const targetPath = path.join(targetRoot, relativeFile);

    if (!targetSet.has(relativeFile)) {
      problems.push(`mirror: missing file ${relativeFile}`);
      continue;
    }

    const expectedContent = getMirroredContent(sourcePath);
    const actualContent = readFileSync(targetPath);
    if (!expectedContent.equals(actualContent)) {
      problems.push(`mirror: content differs for ${relativeFile}`);
    }
  }

  const sourceSet = new Set(sourceFiles);
  for (const relativeFile of targetFiles) {
    if (!sourceSet.has(relativeFile)) {
      problems.push(`mirror: unexpected file ${relativeFile}`);
    }
  }

  return problems;
}

export function addJsExtensions(sourcePath, source) {
  return source.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g,
    (_match, prefix, specifier, suffix) => {
      if (
        specifier.endsWith('.js') ||
        specifier.endsWith('.json') ||
        specifier.endsWith('.mjs') ||
        specifier.endsWith('.cjs')
      ) {
        return `${prefix}${specifier}${suffix}`;
      }
      const resolvedBase = path.resolve(path.dirname(sourcePath), specifier);
      if (existsSync(path.join(resolvedBase, 'index.ts'))) {
        return `${prefix}${specifier}/index.js${suffix}`;
      }
      return `${prefix}${specifier}.js${suffix}`;
    },
  );
}

export function listRelativeFiles(rootDir) {
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

function getMirroredContent(sourcePath) {
  if (!sourcePath.endsWith('.ts')) {
    return readFileSync(sourcePath);
  }

  return Buffer.from(addJsExtensions(sourcePath, readFileSync(sourcePath, 'utf8')));
}
