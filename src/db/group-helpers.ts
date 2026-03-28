import type { ExecutionMode, RegisteredGroup } from '../types.js';

function parseExecutionMode(
  raw: string | null,
  context: string,
): ExecutionMode {
  if (raw === 'container' || raw === 'host') return raw;
  if (raw !== null && raw !== '') {
    console.warn(
      `Invalid execution_mode "${raw}" for ${context}, falling back to "container"`,
    );
  }
  return 'container';
}

/** Raw row shape from registered_groups table — single source of truth for column mapping. */
type RegisteredGroupRow = {
  jid: string;
  name: string;
  folder: string;
  added_at: string;
  container_config: string | null;
  execution_mode: string | null;
  runtime: string | null;
  custom_cwd: string | null;
  init_source_path: string | null;
  init_git_url: string | null;
  created_by: string | null;
  is_home: number;
  selected_skills: string | null;
  target_agent_id: string | null;
  target_main_jid: string | null;
  reply_policy: string | null;
  require_mention: number;
  activation_mode: string | null;
  mcp_mode: string | null;
  selected_mcps: string | null;
};

/** Convert a raw DB row into a RegisteredGroup domain object. */
function parseGroupRow(
  row: RegisteredGroupRow,
): RegisteredGroup & { jid: string } {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    executionMode: parseExecutionMode(row.execution_mode, `group ${row.jid}`),
    customCwd: row.custom_cwd ?? undefined,
    initSourcePath: row.init_source_path ?? undefined,
    initGitUrl: row.init_git_url ?? undefined,
    created_by: row.created_by ?? undefined,
    is_home: row.is_home === 1,
    target_agent_id: row.target_agent_id ?? undefined,
    target_main_jid: row.target_main_jid ?? undefined,
    reply_policy: row.reply_policy === 'mirror' ? 'mirror' : 'source_only',
    require_mention: row.require_mention === 1,
    activation_mode: parseActivationMode(row.activation_mode),
  };
}

const VALID_ACTIVATION_MODES = new Set([
  'auto',
  'always',
  'when_mentioned',
  'disabled',
]);

function parseActivationMode(
  raw: string | null,
): 'auto' | 'always' | 'when_mentioned' | 'disabled' {
  if (raw && VALID_ACTIVATION_MODES.has(raw))
    return raw as 'auto' | 'always' | 'when_mentioned' | 'disabled';
  return 'auto';
}

export { parseExecutionMode, parseGroupRow, type RegisteredGroupRow };
