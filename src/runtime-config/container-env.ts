import fs from 'fs';
import path from 'path';

import { logger } from '../app/logger.js';
import { getCodexProviderConfig } from './im-config.js';
import type {
  CodexProviderConfig,
  ContainerEnvConfig,
  ContainerEnvPublicConfig,
} from './types.js';
import {
  CONTAINER_ENV_DIR,
  DANGEROUS_ENV_VARS,
  ENV_KEY_RE,
  sanitizeEnvValue,
} from './shared.js';

function containerEnvPath(folder: string): string {
  if (folder.includes('..') || folder.includes('/')) {
    throw new Error('Invalid folder name');
  }
  return path.join(CONTAINER_ENV_DIR, `${folder}.json`);
}

function sanitizeContainerCustomEnv(
  input: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!input) return undefined;

  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ENV_KEY_RE.test(key)) {
      logger.warn({ key }, 'Skipping invalid env key in container custom env');
      continue;
    }
    if (DANGEROUS_ENV_VARS.has(key)) {
      logger.warn(
        { key },
        'Blocked reserved env variable in container custom env',
      );
      continue;
    }
    cleanEnv[key] = sanitizeEnvValue(value);
  }
  return cleanEnv;
}

export function getContainerEnvConfig(folder: string): ContainerEnvConfig {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) {
      const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        customEnv?: Record<string, string>;
      };
      return {
        customEnv: sanitizeContainerCustomEnv(stored.customEnv) ?? {},
      };
    }
  } catch (err) {
    logger.warn(
      { err, folder },
      'Failed to read container env config, returning defaults',
    );
  }
  return {};
}

export function saveContainerEnvConfig(
  folder: string,
  config: ContainerEnvConfig,
): void {
  const sanitized: ContainerEnvConfig = {
    customEnv: sanitizeContainerCustomEnv(config.customEnv) ?? {},
  };

  fs.mkdirSync(CONTAINER_ENV_DIR, { recursive: true });
  const tmp = `${containerEnvPath(folder)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, containerEnvPath(folder));
}

export function deleteContainerEnvConfig(folder: string): void {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export function toPublicContainerEnvConfig(
  config: ContainerEnvConfig,
): ContainerEnvPublicConfig {
  return {
    customEnv: sanitizeContainerCustomEnv(config.customEnv) || {},
  };
}

export function shellQuoteEnvLines(lines: string[]): string[] {
  return lines.map((line) => {
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) return line;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    const quoted = "'" + value.replace(/'/g, "'\\''") + "'";
    return `${key}=${quoted}`;
  });
}

export function buildContainerEnvLines(
  override: ContainerEnvConfig,
  codexConfig?: CodexProviderConfig,
): string[] {
  const lines: string[] = [];

  const effectiveCodexConfig = codexConfig ?? getCodexProviderConfig();
  if (effectiveCodexConfig.openaiApiKey) {
    lines.push(
      `OPENAI_API_KEY=${sanitizeEnvValue(effectiveCodexConfig.openaiApiKey)}`,
    );
  }
  if (effectiveCodexConfig.openaiModel) {
    lines.push(
      `OPENAI_MODEL=${sanitizeEnvValue(effectiveCodexConfig.openaiModel)}`,
    );
  }

  const safeCustomEnv = sanitizeContainerCustomEnv(override.customEnv);
  if (safeCustomEnv) {
    for (const [key, value] of Object.entries(safeCustomEnv)) {
      lines.push(`${key}=${value}`);
    }
  }

  return lines;
}
