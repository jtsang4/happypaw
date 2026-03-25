import { useState } from 'react';
import { toast } from 'sonner';
import { GroupInfo } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
}

export function GroupDetail({ group }: GroupDetailProps) {
  const updateFlowRuntime = useChatStore((s) => s.updateFlowRuntime);
  const canManageSystemConfig = useAuthStore((s) => s.hasPermission('manage_system_config'));
  const [savingRuntime, setSavingRuntime] = useState(false);

  const formatDate = (timestamp: string | number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const runtimeLabel = (runtime?: 'claude_sdk' | 'codex_app_server') => {
    if (runtime === 'codex_app_server') return 'Codex';
    if (runtime === 'claude_sdk') return 'Claude';
    return '系统默认';
  };

  const executionModeLabel =
    group.execution_mode === 'host' ? '宿主机' : 'Docker';

  const runtimeSelectValue = group.runtime ?? '__default__';

  const handleRuntimeChange = async (
    value: 'claude_sdk' | 'codex_app_server' | '__default__',
  ) => {
    setSavingRuntime(true);
    try {
      await updateFlowRuntime(
        group.jid,
        value === '__default__' ? null : value,
      );
      toast.success('运行时覆盖已更新');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新运行时失败');
    } finally {
      setSavingRuntime(false);
    }
  };

  return (
    <div className="p-4 bg-background space-y-3">
      {/* JID */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">完整 JID</div>
        <code className="block text-xs font-mono bg-card px-3 py-2 rounded border border-border break-all">
          {group.jid}
        </code>
      </div>

      {/* Folder */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">文件夹</div>
        <div className="text-sm text-foreground font-medium">{group.folder}</div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-xs text-muted-foreground mb-1">执行模式</div>
          <div className="text-sm text-foreground">{executionModeLabel}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">运行时覆盖</div>
          {group.editable && canManageSystemConfig ? (
            <Select
              value={runtimeSelectValue}
              onValueChange={(value: 'claude_sdk' | 'codex_app_server' | '__default__') =>
                void handleRuntimeChange(value)
              }
              disabled={savingRuntime}
            >
              <SelectTrigger className="w-full sm:w-48 h-9">
                <SelectValue placeholder="选择运行时覆盖" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">系统默认</SelectItem>
                <SelectItem value="claude_sdk">Claude</SelectItem>
                <SelectItem value="codex_app_server">Codex</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <div className="text-sm text-foreground">{runtimeLabel(group.runtime)}</div>
          )}
        </div>
        <div className="sm:col-span-2">
          <div className="text-xs text-muted-foreground mb-1">生效运行时</div>
          <div className="text-sm text-foreground">
            {runtimeLabel(group.effective_runtime)}
          </div>
        </div>
      </div>

      {/* Added At */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">添加时间</div>
        <div className="text-sm text-foreground">
          {formatDate(group.added_at)}
        </div>
      </div>

      {/* Last Message */}
      {group.lastMessage && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">最后消息</div>
          <div className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border line-clamp-3 break-words">
            {group.lastMessage}
          </div>
          {group.lastMessageTime && (
            <div className="text-xs text-muted-foreground mt-1">
              {formatDate(group.lastMessageTime)}
            </div>
          )}
        </div>
      )}

      {/* Note */}
      <div className="text-xs text-muted-foreground pt-2 border-t border-border">
        暂不支持编辑群组配置
      </div>
    </div>
  );
}
