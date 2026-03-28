import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useContainerEnvStore } from '../../stores/container-env';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ContainerEnvPanelProps {
  groupJid: string;
  onClose?: () => void;
}

export function ContainerEnvPanel({ groupJid, onClose }: ContainerEnvPanelProps) {
  const { configs, loading, saving, loadConfig, saveConfig } = useContainerEnvStore();
  const config = configs[groupJid];

  const [customEnv, setCustomEnv] = useState<{ key: string; value: string }[]>([]);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [clearing, setClearing] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (groupJid) loadConfig(groupJid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // Cleanup save-success timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Sync config to draft when loaded
  useEffect(() => {
    if (!config) return;
    const entries = Object.entries(config.customEnv || {}).map(([key, value]) => ({ key, value }));
    setCustomEnv(entries);
  }, [config]);

  const handleSave = async () => {
    const envMap: Record<string, string> = {};
    for (const { key, value } of customEnv) {
      const k = key.trim();
      if (!k) continue;
      envMap[k] = value;
    }
    const ok = await saveConfig(groupJid, { customEnv: envMap });
    if (ok) {
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('确定要清空该工作区的自定义环境变量并重建工作区吗？')) return;
    setClearing(true);
    const ok = await saveConfig(groupJid, {
      customEnv: {},
    });
    setClearing(false);
    if (ok) {
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
      setCustomEnv([]);
    }
  };

  const addCustomEnv = () => {
    setCustomEnv((prev) => [...prev, { key: '', value: '' }]);
  };

  const removeCustomEnv = (index: number) => {
    setCustomEnv((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCustomEnv = (index: number, field: 'key' | 'value', val: string) => {
    setCustomEnv((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: val } : item))
    );
  };

  if (loading && !config) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center">加载中...</div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-foreground text-sm">工作区环境变量</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadConfig(groupJid)}
            className="text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted cursor-pointer"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          当前面板仅管理工作区级自定义环境变量。保存后，工作区会自动重建并在下次启动时应用这些变量。
        </p>

        {/* Custom Env Vars */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-muted-foreground">自定义环境变量</label>
            <button
              onClick={addCustomEnv}
              className="flex-shrink-0 flex items-center gap-1 text-[11px] text-primary hover:text-primary cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              添加
            </button>
          </div>

          {customEnv.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              暂无自定义变量。Codex 默认配置会继续沿用系统全局设置。
            </p>
          ) : (
            <div className="space-y-1.5">
              {customEnv.map((item, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    type="text"
                    value={item.key}
                    onChange={(e) => updateCustomEnv(i, 'key', e.target.value)}
                    placeholder="KEY"
                    className="w-[40%] px-2 py-1 text-[11px] font-mono h-auto"
                  />
                  <span className="text-muted-foreground/50 text-xs">=</span>
                  <Input
                    type="text"
                    value={item.value}
                    onChange={(e) => updateCustomEnv(i, 'value', e.target.value)}
                    placeholder="value"
                    className="flex-1 px-2 py-1 text-[11px] font-mono h-auto"
                  />
                  <button
                    onClick={() => removeCustomEnv(i)}
                    className="flex-shrink-0 p-1 text-muted-foreground hover:text-red-500 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-3 border-t border-border space-y-2">
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || clearing} className="flex-1" size="sm">
            {saving && <Loader2 className="size-4 animate-spin" />}
            <Save className="w-4 h-4" />
            {saveSuccess ? '已保存' : '保存并重建工作区'}
          </Button>
          <Button
            onClick={handleClear}
            disabled={saving || clearing}
            variant="outline"
            size="sm"
            title="清空自定义环境变量"
          >
            {clearing && <Loader2 className="size-4 animate-spin" />}
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
        {saveSuccess && (
          <p className="text-[11px] text-primary text-center">
            配置已保存，工作区已重建
          </p>
        )}
      </div>
    </div>
  );
}
