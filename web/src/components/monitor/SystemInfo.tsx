import { Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { SystemStatus } from '../../stores/monitor.ts';

interface SystemInfoProps {
  status: SystemStatus;
}

function extractVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

export function SystemInfo({ status }: SystemInfoProps) {
  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const diagnostics = status.codexDiagnostics;
  const helperEntries = diagnostics
    ? [
        {
          label: '任务解析助手',
          value: diagnostics.helperReadiness.taskParsing,
        },
        {
          label: 'Bug 报告助手',
          value: diagnostics.helperReadiness.bugReportGeneration,
        },
        {
          label: 'GitHub 提交',
          value: diagnostics.helperReadiness.githubIssueSubmission,
        },
      ]
    : [];

  return (
    <Card>
      <CardContent>
        <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-success-bg rounded-lg">
          <Activity className="w-6 h-6 text-success" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">系统信息</h3>
          <p className="text-2xl font-bold text-foreground">运行中</p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">运行时间</span>
          <span className="text-foreground font-medium">
            {formatUptime(status.uptime)}
          </span>
        </div>

        {diagnostics !== undefined && (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">固定 Codex</span>
              <span className="text-foreground font-medium font-mono text-xs flex items-center">
                {extractVersion(diagnostics?.pinnedVersion) ||
                  diagnostics?.pinnedVersion ||
                  '未知'}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">发布来源</span>
              <span className="text-foreground font-medium text-xs text-right max-w-[60%]">
                {diagnostics?.releaseSource || '未知'}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">版本标签</span>
              <span className="text-foreground font-medium font-mono text-xs flex items-center">
                {diagnostics?.releaseTag || '未知'}
              </span>
            </div>
            <div className="flex items-start justify-between gap-3 text-sm">
              <span className="text-muted-foreground">仓库缓存</span>
              <div className="text-right">
                <div className="text-foreground font-medium text-xs">
                  {diagnostics?.repoCache.prepared ? '已准备' : '未准备'}
                </div>
                <div className="text-[11px] text-muted-foreground break-all max-w-[220px]">
                  {diagnostics?.repoCache.executablePath || '未发现缓存路径'}
                </div>
              </div>
            </div>
            <div className="flex items-start justify-between gap-3 text-sm">
              <span className="text-muted-foreground">宿主机引导</span>
              <div className="text-right">
                <div className="text-foreground font-medium text-xs">
                  {diagnostics?.hostBootstrap.cached ? '缓存已命中' : '首次启动时下载'}
                </div>
                <div className="text-[11px] text-muted-foreground break-all max-w-[220px]">
                  {diagnostics?.hostBootstrap.executablePath || '未解析宿主机路径'}
                </div>
              </div>
            </div>
            <div className="flex items-start justify-between gap-3 text-sm">
              <span className="text-muted-foreground">容器内路径</span>
              <div className="text-right">
                <div className="text-foreground font-medium text-xs">
                  {diagnostics?.containerBundle.imageReady ? '镜像可用' : '镜像未构建'}
                </div>
                <div className="text-[11px] text-muted-foreground break-all max-w-[220px]">
                  {diagnostics?.containerBundle.executablePath || '未知'}
                </div>
              </div>
            </div>
            {helperEntries.map((entry) => (
              <div
                key={entry.label}
                className="flex items-start justify-between gap-3 text-sm"
              >
                <span className="text-muted-foreground">{entry.label}</span>
                <div className="text-right">
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                      entry.value.ready
                        ? 'bg-success-bg text-success'
                        : 'bg-warning-bg text-warning'
                    }`}
                  >
                    {entry.value.ready ? '已就绪' : '需配置 / 回退'}
                  </span>
                  <div className="mt-1 text-[11px] text-muted-foreground max-w-[220px] break-words">
                    {entry.value.detail}
                  </div>
                </div>
              </div>
            ))}
          </>

        )}
        </div>
      </CardContent>
    </Card>
  );
}
