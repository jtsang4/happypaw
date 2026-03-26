import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { resolveRuntimeScopePaths } from './container-runner.js';
import { deleteAllSessionsForFolder } from './db.js';
import { deleteContainerEnvConfig } from './runtime-config.js';

export function clearSessionRuntimeFiles(
  folder: string,
  agentId?: string,
): void {
  const runtimeScope = resolveRuntimeScopePaths(folder, { agentId });
  const targets = [
    { dir: runtimeScope.claudeSessionDir, keep: new Set(['settings.json']) },
    { dir: runtimeScope.codexHomeDir, keep: new Set(['config.toml']) },
  ];

  for (const target of targets) {
    if (!fs.existsSync(target.dir)) continue;
    for (const entry of fs.readdirSync(target.dir)) {
      if (target.keep.has(entry)) continue;
      fs.rmSync(path.join(target.dir, entry), { recursive: true, force: true });
    }
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
