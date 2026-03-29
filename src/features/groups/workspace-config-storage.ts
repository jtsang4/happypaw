import path from 'path';

import { CURRENT_PRODUCT_ID } from '../../product.js';

const WORKSPACE_CONFIG_DIRNAME = `.${CURRENT_PRODUCT_ID}`;
const WORKSPACE_MCP_FILE = 'workspace-mcp.json';

export function getWorkspaceConfigDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, WORKSPACE_CONFIG_DIRNAME);
}

export function getWorkspaceSkillsDirFromRoot(workspaceRoot: string): string {
  return path.join(getWorkspaceConfigDir(workspaceRoot), 'skills');
}

export function getWorkspaceMcpConfigPathFromRoot(
  workspaceRoot: string,
): string {
  return path.join(getWorkspaceConfigDir(workspaceRoot), WORKSPACE_MCP_FILE);
}
