import { useState } from 'react';
import { toast } from 'sonner';
import { GroupInfo } from '../../stores/groups.ts';

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
}

export function GroupDetail({ group }: GroupDetailProps) {
  const [copied, setCopied] = useState(false);

  const formatDate = (timestamp: string | number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const executionModeLabel =
    group.execution_mode === 'host' ? '宿主机' : 'Docker';

  return (
    <div className="p-4 bg-background space-y-3">
      {/* JID */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">完整 JID</div>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(group.jid);
              setCopied(true);
              toast.success('JID 已复制');
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error('复制失败，请手动复制');
            }
          }}
          className="block w-full text-left text-xs font-mono bg-card px-3 py-2 rounded border border-border break-all hover:bg-muted transition-colors cursor-pointer"
          title="点击复制 JID"
        >
          {group.jid}
          {copied && <span className="ml-2 text-primary">已复制</span>}
        </button>
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
          <div className="text-xs text-muted-foreground mb-1">AI 运行时</div>
          <div className="text-sm text-foreground">Codex（固定）</div>
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
        工作区始终使用 Codex，当前面板仅展示执行模式和基础信息。
      </div>
    </div>
  );
}
