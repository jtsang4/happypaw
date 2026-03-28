export interface CreateFlowRequestOptions {
  execution_mode?: 'container' | 'host';
  custom_cwd?: string;
  init_source_path?: string;
  init_git_url?: string;
}

interface BuildCreateFlowOptionsInput {
  executionMode: 'container' | 'host';
  customCwd: string;
  initMode: 'empty' | 'local' | 'git';
  initSourcePath: string;
  initGitUrl: string;
}

export function buildCreateFlowOptions({
  executionMode,
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

  return Object.keys(options).length > 0 ? options : undefined;
}
