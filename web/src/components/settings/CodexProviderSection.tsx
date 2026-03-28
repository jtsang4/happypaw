import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CodexConfigPublic } from './types';
import { getErrorMessage } from './types';

export function CodexProviderSection() {
  const [config, setConfig] = useState<CodexConfigPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.get<CodexConfigPublic>('/api/config/codex');
        setConfig(data);
        setBaseUrl('');
        setModel(data.openaiModel || '');
        setApiKey('');
        setClearApiKey(false);
      } catch (err) {
        toast.error(getErrorMessage(err, '加载 Codex 配置失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const [updatedConfig, updatedSecrets] = await Promise.all([
        api.put<CodexConfigPublic>('/api/config/codex', {
          openaiBaseUrl: baseUrl.trim(),
          openaiModel: model.trim(),
        }),
        apiKey.trim() || clearApiKey
          ? api.put<CodexConfigPublic>('/api/config/codex/secrets', {
              ...(apiKey.trim() ? { openaiApiKey: apiKey.trim() } : {}),
              ...(clearApiKey ? { clearOpenaiApiKey: true } : {}),
            })
          : Promise.resolve<CodexConfigPublic | null>(null),
      ]);
      const next = updatedSecrets ?? updatedConfig;
      setConfig(next);
      setBaseUrl('');
      setModel(next.openaiModel || '');
      setApiKey('');
      setClearApiKey(false);
      toast.success('Codex 配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 Codex 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        HappyPaw 现已固定为 Codex 运行时。只需配置 Codex / OpenAI 兼容网关即可完成系统接入。
      </p>

      <div className="space-y-5 rounded-xl border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">当前状态</h3>
          <p className="text-xs text-muted-foreground mt-1">
            所有敏感信息均以脱敏形式展示，支持随时更新或清空 API Key。
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label className="mb-1">当前 Base URL</Label>
            <div className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
              {config?.hasOpenaiBaseUrl
                ? (config.openaiBaseUrlMasked ?? '已配置')
                : '未配置'}
            </div>
          </div>
          <div>
            <Label className="mb-1">当前 API Key</Label>
            <div className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
              {config?.hasOpenaiApiKey
                ? (config.openaiApiKeyMasked ?? '已配置')
                : '未配置'}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-5 rounded-xl border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">更新默认配置</h3>
          <p className="text-xs text-muted-foreground mt-1">
            留空 Base URL 表示使用默认官方网关；Model 为空时使用运行时默认模型。
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label className="mb-1">OpenAI Base URL</Label>
            <Input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div>
            <Label className="mb-1">OpenAI Model</Label>
            <Input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="例如 codex-mini-latest"
            />
          </div>
          <div>
            <Label className="mb-1">更新 API Key</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (e.target.value.trim()) setClearApiKey(false);
              }}
              placeholder="留空则保持当前密钥"
            />
          </div>
          <label className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
            <div>
              <div className="font-medium text-foreground">清空当前 API Key</div>
              <div className="text-xs text-muted-foreground mt-1">
                仅在不填写新 Key 时勾选。
              </div>
            </div>
            <input
              type="checkbox"
              checked={clearApiKey}
              onChange={(e) => {
                setClearApiKey(e.target.checked);
                if (e.target.checked) setApiKey('');
              }}
              className="h-4 w-4 accent-primary"
            />
          </label>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存 Codex 配置
          </Button>
        </div>
      </div>
    </div>
  );
}
