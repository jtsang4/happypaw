import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { parseFrontmatter, validateSkillId } from './skill-utils.js';

const execFileAsync = promisify(execFile);

interface ParsedSkillPackage {
  source: string;
  skillId?: string;
}

function parseSkillsShUrl(url: URL): ParsedSkillPackage | null {
  const segments = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'skills.sh' && segments[0] === 's') {
    if (segments.length >= 4) {
      return {
        source: `${segments[1]}/${segments[2]}`,
        skillId: segments[3],
      };
    }
    return null;
  }
  return null;
}

function parseGithubUrl(url: URL): ParsedSkillPackage | null {
  if (url.hostname !== 'github.com') return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return { source: `${segments[0]}/${segments[1].replace(/\.git$/u, '')}` };
}

export function parseSkillPackage(pkg: string): ParsedSkillPackage | null {
  const trimmed = pkg.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//u.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return parseSkillsShUrl(url) ?? parseGithubUrl(url);
    } catch {
      return null;
    }
  }

  const match = trimmed.match(/^([\w-]+\/[\w.-]+)(?:[@#]([\w./-]+))?$/u);
  if (!match) return null;
  return {
    source: match[1],
    skillId: match[2] || undefined,
  };
}

function normalizeSkillDirName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return validateSkillId(normalized) ? normalized : '';
}

function getSkillDirName(skillDir: string, fallbackName: string): string {
  const skillFilePath = path.join(skillDir, 'SKILL.md');
  try {
    const frontmatter = parseFrontmatter(
      fs.readFileSync(skillFilePath, 'utf-8'),
    );
    const fromFrontmatter = normalizeSkillDirName(frontmatter.name || '');
    if (fromFrontmatter) return fromFrontmatter;
  } catch {
    // ignore malformed frontmatter and fall back to directory naming
  }

  const basename = path.basename(skillDir);
  const normalizedBase = normalizeSkillDirName(basename);
  if (normalizedBase && basename !== '.') return normalizedBase;

  return normalizeSkillDirName(fallbackName);
}

function maybeAddSkillDir(
  result: string[],
  repoDir: string,
  relativeDir: string,
): void {
  const fullDir = path.join(repoDir, relativeDir);
  if (fs.existsSync(path.join(fullDir, 'SKILL.md'))) {
    result.push(fullDir);
  }
}

function discoverSkillDirs(
  repoDir: string,
  parsed: ParsedSkillPackage,
): string[] {
  const result: string[] = [];

  if (parsed.skillId) {
    for (const relativeDir of [
      path.join('skills', parsed.skillId),
      path.join('.codex', 'skills', parsed.skillId),
      parsed.skillId,
      '.',
    ]) {
      maybeAddSkillDir(result, repoDir, relativeDir);
    }
    return Array.from(new Set(result));
  }

  for (const skillsRoot of ['skills', path.join('.codex', 'skills')]) {
    const fullRoot = path.join(repoDir, skillsRoot);
    if (!fs.existsSync(fullRoot) || !fs.statSync(fullRoot).isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(fullRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      maybeAddSkillDir(result, repoDir, path.join(skillsRoot, entry.name));
    }
  }

  if (fs.existsSync(path.join(repoDir, 'SKILL.md'))) {
    result.push(repoDir);
  }

  if (result.length === 0) {
    for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      maybeAddSkillDir(result, repoDir, entry.name);
    }
  }

  return Array.from(new Set(result));
}

export async function installSkillPackageToDirectory(
  pkg: string,
  targetDir: string,
): Promise<string[]> {
  const parsed = parseSkillPackage(pkg);
  if (!parsed) {
    throw new Error('Invalid package name format');
  }

  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'happypaw-skill-install-'),
  );
  const repoDir = path.join(tempRoot, 'repo');
  const repoUrl = `https://github.com/${parsed.source}.git`;
  const repoFallbackName =
    parsed.skillId || parsed.source.split('/').at(-1) || 'skill';

  try {
    await execFileAsync('git', ['clone', '--depth', '1', repoUrl, repoDir], {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    const skillDirs = discoverSkillDirs(repoDir, parsed);
    if (skillDirs.length === 0) {
      throw new Error('No installable Codex skill found in repository');
    }

    fs.mkdirSync(targetDir, { recursive: true });

    const installed: string[] = [];
    for (const skillDir of skillDirs) {
      const dirName = getSkillDirName(skillDir, repoFallbackName);
      if (!dirName) {
        throw new Error('Installed skill is missing a valid directory name');
      }
      const destination = path.join(targetDir, dirName);
      if (fs.existsSync(destination)) {
        fs.rmSync(destination, { recursive: true, force: true });
      }
      fs.cpSync(skillDir, destination, { recursive: true });
      installed.push(dirName);
    }

    return installed;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
