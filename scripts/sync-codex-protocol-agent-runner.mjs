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
const repoRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(repoRoot, 'generated', 'codex-app-server-protocol', 'ts');
const targetDir = path.join(
  repoRoot,
  'container',
  'agent-runner',
  'src',
  'generated',
  'codex-app-server-protocol',
);

const transformedFiles = new Map();

copyDirectory(sourceDir);

function copyDirectory(currentSourceDir) {
  const relativeDir = path.relative(sourceDir, currentSourceDir);
  const currentTargetDir =
    relativeDir === '' ? targetDir : path.join(targetDir, relativeDir);
  mkdirSync(currentTargetDir, { recursive: true });

  for (const entry of readdirSync(currentSourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(currentSourceDir, entry.name);
    const relativePath =
      relativeDir === ''
        ? entry.name
        : path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name);
    const targetPath = path.join(currentTargetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath);
      continue;
    }

    if (!entry.isFile()) continue;

    if (entry.name.endsWith('.ts')) {
      const transformed = addJsExtensions(sourcePath, readFileSync(sourcePath, 'utf8'));
      transformedFiles.set(path.normalize(targetPath), true);
      if (!existsSync(targetPath) || readFileSync(targetPath, 'utf8') !== transformed) {
        writeFileSync(targetPath, transformed);
      }
      continue;
    }

    transformedFiles.set(path.normalize(targetPath), true);
    cpSync(sourcePath, targetPath, { force: true });
  }
}

pruneRemovedTargets(targetDir);

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

function addJsExtensions(sourcePath, source) {
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
