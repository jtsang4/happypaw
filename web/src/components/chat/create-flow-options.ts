export type RuntimeOverrideSelection =
  | '__default__'
  | 'claude_sdk'
  | 'codex_app_server';

export interface CreateFlowRequestOptions {
  execution_mode?: 'container' | 'host';
  runtime?: 'claude_sdk' | 'codex_app_server';
  custom_cwd?: string;
  init_source_path?: string;
  init_git_url?: string;
}

interface BuildCreateFlowOptionsInput {
  executionMode: 'container' | 'host';
  runtimeSelection: RuntimeOverrideSelection;
  customCwd: string;
  initMode: 'empty' | 'local' | 'git';
  initSourcePath: string;
  initGitUrl: string;
}

export function buildCreateFlowOptions({
  executionMode,
  runtimeSelection,
  customCwd,
  initMode,
  initSourcePath,
  initGitUrl,
}: BuildCreateFlowOptionsInput): CreateFlowRequestOptions | undefined {
  const options: CreateFlowRequestOptions = {};

  if (executionMode === 'host') {
    options.execution_mode = 'host';
    if (customCwd.trim()) options.custom_cwd = customCwd.trim();
  } else if (initMode === 'local' && initSourcePath.trim()) {
    options.init_source_path = initSourcePath.trim();
  } else if (initMode === 'git' && initGitUrl.trim()) {
    options.init_git_url = initGitUrl.trim();
  }

  if (runtimeSelection !== '__default__') {
    options.runtime = runtimeSelection;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}
