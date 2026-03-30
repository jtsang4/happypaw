import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR } from '../../app/config.js';
import { resolveRuntimeScopePaths } from '../execution/container-runner.js';
import { deleteAllSessionsForFolder, deleteSession } from '../../db.js';
import { logger } from '../../app/logger.js';
import { deleteContainerEnvConfig } from '../../runtime-config.js';
import type { RuntimeSessionRecord } from '../../shared/types.js';

export function clearSessionRuntimeFiles(
  folder: string,
  scope?: string | { agentId?: string | null; conversationId?: string | null },
  taskRunId?: string,
): void {
  const runtimeScope =
    typeof scope === 'string'
      ? resolveRuntimeScopePaths(folder, { agentId: scope, taskRunId })
      : resolveRuntimeScopePaths(folder, {
          agentId: scope?.agentId || undefined,
          conversationId: scope?.conversationId || undefined,
          taskRunId,
        });
  const targets: Array<{ dir: string; keep: Set<string> }> = [
    { dir: runtimeScope.codexHomeDir, keep: new Set(['config.toml']) },
  ];

  let cleared = true;
  for (const target of targets) {
    if (!fs.existsSync(target.dir)) continue;
    try {
      for (const entry of fs.readdirSync(target.dir)) {
        if (target.keep.has(entry)) continue;
        fs.rmSync(path.join(target.dir, entry), {
          recursive: true,
          force: true,
        });
      }
    } catch {
      cleared = false;
      logger.info(
        { folder, scope, dir: target.dir },
        'Direct session cleanup failed for runtime dir, trying Docker fallback',
      );
    }
  }

  if (cleared) return;

  const volumeArgs: string[] = [];
  if (fs.existsSync(runtimeScope.codexHomeDir)) {
    volumeArgs.push('-v', `${runtimeScope.codexHomeDir}:/target/codex`);
  }
  if (volumeArgs.length === 0) return;

  try {
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        ...volumeArgs,
        CONTAINER_IMAGE,
        'sh',
        '-c',
        [
          'if [ -d /target/codex ]; then find /target/codex -mindepth 1 -not -name config.toml -exec rm -rf {} + 2>/dev/null; fi',
          'exit 0',
        ].join('; '),
      ],
      { stdio: 'pipe', timeout: 15_000 },
    );
  } catch (err) {
    logger.error({ folder, scope, err }, 'Docker fallback cleanup failed');
  }
}

export function clearPersistedRuntimeStateForRecovery(
  sessions: Record<string, RuntimeSessionRecord>,
  folder: string,
  scope?: string | { agentId?: string | null; conversationId?: string | null },
  taskRunId?: string,
): void {
  clearSessionRuntimeFiles(folder, scope, taskRunId);
  if (!taskRunId) {
    deleteSession(folder, scope);
  }
  const hasDefaultScope =
    !scope ||
    (typeof scope !== 'string' && !scope.agentId && !scope.conversationId);
  if (hasDefaultScope && !taskRunId) {
    delete sessions[folder];
  }
}

export function clearWorkspaceRuntimeState(folder: string): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.mkdirSync(groupDir, { recursive: true });

  fs.rmSync(path.join(DATA_DIR, 'sessions', folder), {
    recursive: true,
    force: true,
  });

  const ipcDir = path.join(DATA_DIR, 'ipc', folder);
  fs.rmSync(ipcDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });

  fs.rmSync(path.join(DATA_DIR, 'memory', folder), {
    recursive: true,
    force: true,
  });

  deleteContainerEnvConfig(folder);
  deleteAllSessionsForFolder(folder);
}
