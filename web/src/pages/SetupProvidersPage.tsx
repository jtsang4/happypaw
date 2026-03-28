import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Loader2,
  Link2,
  MessageSquareMore,
  ShieldCheck,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../api/client';
import type { CodexConfigPublic } from '../components/settings/types';
import { getErrorMessage } from '../components/settings/types';
import { useAuthStore } from '../stores/auth';

export function SetupProvidersPage() {
  const navigate = useNavigate();
  const { user, setupStatus, checkAuth, initialized } = useAuthStore();

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');

  const [codexBaseUrl, setCodexBaseUrl] = useState('');
  const [codexApiKey, setCodexApiKey] = useState('');
  const [codexModel, setCodexModel] = useState('');
  const [existingCodexConfig, setExistingCodexConfig] =
    useState<CodexConfigPublic | null>(null);

  useEffect(() => {
    if (user === null && initialized === true) {
      navigate('/login', { replace: true });
    } else if (user && user.role !== 'admin') {
      navigate('/chat', { replace: true });
    }
  }, [user, initialized, navigate]);

  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup) {
      navigate('/settings?tab=system', { replace: true });
    }
  }, [setupStatus, navigate]);

  useEffect(() => {
    void api
      .get<CodexConfigPublic>('/api/config/codex')
      .then((config) => {
        setExistingCodexConfig(config);
        setCodexModel(config.openaiModel || '');
      })
      .catch(() => {
        setExistingCodexConfig(null);
      });
  }, []);

  const handleFinish = async () => {
    setError(null);
    setNotice(null);

    if (feishuAppSecret.trim() && !feishuAppId.trim()) {
      setError('填写飞书 Secret 时，App ID 也必须填写');
      return;
    }

    if (!codexApiKey.trim() && !existingCodexConfig?.hasOpenaiApiKey) {
      setError('完成初始化至少需要配置一个 Codex / OpenAI 兼容 API Key');
      return;
    }

    setSaving(true);
    try {
      if (feishuAppId.trim() || feishuAppSecret.trim()) {
        const payload: Record<string, string> = {
          appId: feishuAppId.trim(),
        };
        if (feishuAppSecret.trim()) {
          payload.appSecret = feishuAppSecret.trim();
        }
        await api.put('/api/config/user-im/feishu', payload);
      }

      await api.put('/api/config/codex', {
        openaiBaseUrl: codexBaseUrl.trim(),
        openaiModel: codexModel.trim(),
      });

      if (codexApiKey.trim()) {
        await api.put('/api/config/codex/secrets', {
          openaiApiKey: codexApiKey.trim(),
        });
      }

      await checkAuth();
      const { setupStatus: latestStatus } = useAuthStore.getState();
      if (latestStatus?.needsSetup) {
        setError('配置已保存，但系统仍未通过就绪检查，请确认 Codex 配置是否有效');
        return;
      }

      setNotice('Codex 全局配置已保存');
      navigate('/settings?tab=system', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, '保存初始化配置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-screen bg-background overflow-y-auto p-4">
      <div className="w-full max-w-4xl mx-auto space-y-5">
        <div className="text-center">
          <p className="text-xs font-semibold text-primary tracking-wider mb-2">
            STEP 2 / 2
          </p>
          <h1 className="text-2xl font-bold text-foreground mb-2">
            系统接入初始化
          </h1>
          <p className="text-sm text-muted-foreground">
            首次安装只需要完成 Codex 默认配置；消息通道可选，后续也能在设置页继续修改。
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-error-bg border border-error/30 text-error text-sm">
            {error}
          </div>
        )}
        {notice && (
          <div className="p-3 rounded-lg bg-success-bg border border-success/30 text-success text-sm">
            {notice}
          </div>
        )}

        <section className="bg-card rounded-xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Link2 className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              Codex 默认配置
            </h2>
          </div>
          <div className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground mb-4">
            <div className="font-medium mb-2">当前向导已改为 Codex-only</div>
            <ol className="list-decimal ml-5 space-y-1 text-xs text-muted-foreground">
              <li>系统初始化仅依赖 Codex 配置，不再需要额外的旧版运行时设置。</li>
              <li>API Key 通过独立密钥接口保存，页面始终只显示脱敏结果。</li>
              <li>Base URL 和 Model 可选；留空时使用默认网关与运行时默认模型。</li>
            </ol>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                OpenAI Base URL（可选）
              </label>
              <Input
                type="text"
                value={codexBaseUrl}
                onChange={(e) => setCodexBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
              {existingCodexConfig?.hasOpenaiBaseUrl && (
                <p className="text-xs text-muted-foreground mt-1">
                  当前已配置：{existingCodexConfig.openaiBaseUrlMasked}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                OpenAI Model（可选）
              </label>
              <Input
                type="text"
                value={codexModel}
                onChange={(e) => setCodexModel(e.target.value)}
                placeholder="例如 gpt-4.1 / codex-mini-latest"
                className="font-mono"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                OpenAI API Key（
                {existingCodexConfig?.hasOpenaiApiKey ? '可留空保持现状' : '必填'}
                ）
              </label>
              <Input
                type="password"
                value={codexApiKey}
                onChange={(e) => setCodexApiKey(e.target.value)}
                placeholder="输入 Codex / OpenAI 兼容 API Key"
              />
              {existingCodexConfig?.hasOpenaiApiKey && (
                <p className="text-xs text-muted-foreground mt-1">
                  当前已配置：{existingCodexConfig.openaiApiKeyMasked}
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="bg-card rounded-xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <MessageSquareMore className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              飞书通道（可选）
            </h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            如果暂时只打算通过 Web 使用 HappyPaw，可以先跳过这里，稍后再到“消息通道”里补充配置。
          </p>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                飞书 App ID
              </label>
              <Input
                type="text"
                value={feishuAppId}
                onChange={(e) => setFeishuAppId(e.target.value)}
                placeholder="仅在需要飞书接入时填写"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                飞书 App Secret
              </label>
              <Input
                type="password"
                value={feishuAppSecret}
                onChange={(e) => setFeishuAppSecret(e.target.value)}
                placeholder="与 App ID 配套使用"
              />
            </div>
          </div>
        </section>

        <div className="bg-card rounded-xl border border-border shadow-sm p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="text-sm text-muted-foreground flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            当前页保存的是系统全局默认配置；完成后即可进入后台继续创建工作区并发起首轮 Codex 对话。
          </div>
          <Button onClick={handleFinish} disabled={saving} className="min-w-64">
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存全局默认并进入后台
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
