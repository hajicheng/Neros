'use client'

import { Eye, EyeOff, FolderUp, KeyRound, Loader2, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AppSettingsRow } from '@/db/schema'
import { fetchAppSettings, updateAppSettings, type AppSettingsPatchBody } from '@/lib/api'
import { subscribeUiCommand } from '@/lib/ui-command-events'

interface SettingsForm {
  anthropicApiKey: string
  anthropicBaseUrl: string
  openaiApiKey: string
  deepseekApiKey: string
  arkApiKey: string
  deploymentPublishEnabled: boolean
  deploymentPublishDir: string
  deploymentPublicBaseUrl: string
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState('keys')
  const [form, setForm] = useState<SettingsForm>({
    anthropicApiKey: '',
    anthropicBaseUrl: '',
    openaiApiKey: '',
    deepseekApiKey: '',
    arkApiKey: '',
    deploymentPublishEnabled: false,
    deploymentPublishDir: '',
    deploymentPublicBaseUrl: '',
  })
  const [reveal, setReveal] = useState<Record<keyof SettingsForm, boolean>>({
    anthropicApiKey: false,
    anthropicBaseUrl: true,
    openaiApiKey: false,
    deepseekApiKey: false,
    arkApiKey: false,
    deploymentPublishEnabled: true,
    deploymentPublishDir: true,
    deploymentPublicBaseUrl: true,
  })

  useEffect(() => {
    if (!open) return
    let cancelled = false

    setLoading(true)
    fetchAppSettings()
      .then((settings) => {
        if (!cancelled) setForm(rowToForm(settings))
      })
      .catch((err) => console.error('[SettingsDialog] load failed', err))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open])

  const handleSave = async () => {
    if (busy) return
    setBusy(true)
    try {
      const patch: AppSettingsPatchBody = {
        anthropicApiKey: form.anthropicApiKey.trim() || null,
        anthropicBaseUrl: form.anthropicBaseUrl.trim() || null,
        openaiApiKey: form.openaiApiKey.trim() || null,
        deepseekApiKey: form.deepseekApiKey.trim() || null,
        arkApiKey: form.arkApiKey.trim() || null,
        deploymentPublishEnabled: form.deploymentPublishEnabled,
        deploymentPublishDir: form.deploymentPublishDir.trim() || null,
        deploymentPublicBaseUrl: form.deploymentPublicBaseUrl.trim() || null,
      }
      await updateAppSettings(patch)
      onOpenChange(false)
    } catch (err) {
      console.error('[SettingsDialog] save failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100vh-2rem)] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription className="sr-only">AgentHub 设置</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-0 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
            <TabsList>
              <TabsTrigger value="keys">
                <KeyRound className="size-3.5" />
                供应商 Key
              </TabsTrigger>
              <TabsTrigger value="publish">
                <FolderUp className="size-3.5" />
                发布
              </TabsTrigger>
            </TabsList>

            <div className="min-h-0 overflow-y-auto pr-1">
              <TabsContent value="keys" className="mt-0 flex flex-col gap-3 py-1">
                <KeyField
                  label="Anthropic API Key"
                  hint="用于 Claude Code adapter / custom anthropic provider。"
                  value={form.anthropicApiKey}
                  reveal={reveal.anthropicApiKey}
                  onChange={(v) => setForm((f) => ({ ...f, anthropicApiKey: v }))}
                  onToggleReveal={() =>
                    setReveal((r) => ({ ...r, anthropicApiKey: !r.anthropicApiKey }))
                  }
                />
                <KeyField
                  label="Anthropic Base URL（可选）"
                  hint="走第三方网关时填，如 https://anyrouter.top；留空走官方 endpoint。"
                  type="text"
                  value={form.anthropicBaseUrl}
                  reveal
                  onChange={(v) => setForm((f) => ({ ...f, anthropicBaseUrl: v }))}
                />
                <KeyField
                  label="OpenAI API Key"
                  value={form.openaiApiKey}
                  reveal={reveal.openaiApiKey}
                  onChange={(v) => setForm((f) => ({ ...f, openaiApiKey: v }))}
                  onToggleReveal={() => setReveal((r) => ({ ...r, openaiApiKey: !r.openaiApiKey }))}
                />
                <KeyField
                  label="DeepSeek API Key"
                  value={form.deepseekApiKey}
                  reveal={reveal.deepseekApiKey}
                  onChange={(v) => setForm((f) => ({ ...f, deepseekApiKey: v }))}
                  onToggleReveal={() => setReveal((r) => ({ ...r, deepseekApiKey: !r.deepseekApiKey }))}
                />
                <KeyField
                  label="Volcano Ark API Key"
                  value={form.arkApiKey}
                  reveal={reveal.arkApiKey}
                  onChange={(v) => setForm((f) => ({ ...f, arkApiKey: v }))}
                  onToggleReveal={() => setReveal((r) => ({ ...r, arkApiKey: !r.arkApiKey }))}
                />
              </TabsContent>

              <TabsContent value="publish" className="mt-0 py-1">
                <DeploymentPublishSettings
                  enabled={form.deploymentPublishEnabled}
                  publishDir={form.deploymentPublishDir}
                  publicBaseUrl={form.deploymentPublicBaseUrl}
                  onEnabledChange={(deploymentPublishEnabled) =>
                    setForm((f) => ({ ...f, deploymentPublishEnabled }))
                  }
                  onPublishDirChange={(deploymentPublishDir) =>
                    setForm((f) => ({ ...f, deploymentPublishDir }))
                  }
                  onPublicBaseUrlChange={(deploymentPublicBaseUrl) =>
                    setForm((f) => ({ ...f, deploymentPublicBaseUrl }))
                  }
                />
              </TabsContent>
            </div>
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void handleSave()} disabled={busy || loading}>
            {busy ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeploymentPublishSettings({
  enabled,
  publishDir,
  publicBaseUrl,
  onEnabledChange,
  onPublishDirChange,
  onPublicBaseUrlChange,
}: {
  enabled: boolean
  publishDir: string
  publicBaseUrl: string
  onEnabledChange: (enabled: boolean) => void
  onPublishDirChange: (value: string) => void
  onPublicBaseUrlChange: (value: string) => void
}) {
  return (
    <section className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FolderUp className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">外部静态发布</h3>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.currentTarget.checked)}
            className="size-4 rounded border-input accent-primary"
          />
          启用
        </label>
      </div>

      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <label className="text-xs font-medium">发布目录</label>
          <Input
            value={publishDir}
            onChange={(event) => onPublishDirChange(event.target.value)}
            placeholder="D:\\sites\\agenthub"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            AgentHub 会写入该目录下的 dep_xxx 子目录。
          </p>
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs font-medium">公开根 URL</label>
          <Input
            value={publicBaseUrl}
            onChange={(event) => onPublicBaseUrlChange(event.target.value)}
            placeholder="https://example.com/apps"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            部署卡片会返回公开根 URL 加 deployment id 的地址。
          </p>
        </div>
      </div>
    </section>
  )
}

function KeyField({
  label,
  hint,
  value,
  reveal,
  type = 'password',
  onChange,
  onToggleReveal,
}: {
  label: string
  hint?: string
  value: string
  reveal: boolean
  type?: 'password' | 'text'
  onChange: (v: string) => void
  onToggleReveal?: () => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium">{label}</label>
      <div className="relative">
        <Input
          type={type === 'text' || reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={onToggleReveal ? 'pr-9 font-mono text-xs' : 'font-mono text-xs'}
        />
        {onToggleReveal && (
          <button
            type="button"
            onClick={onToggleReveal}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            title={reveal ? '隐藏' : '显示'}
          >
            {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        )}
      </div>
      {hint && <p className="text-[10px] text-muted-foreground/80">{hint}</p>}
    </div>
  )
}

export function SettingsButton() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    return subscribeUiCommand((command) => {
      if (command === 'open-settings') setOpen(true)
    })
  }, [])

  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        className="group"
        onClick={() => setOpen(true)}
        title="API 设置"
        aria-label="API 设置"
      >
        <SettingsIcon className="size-4 motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out motion-safe:group-hover:rotate-45 motion-safe:group-active:scale-90" />
      </Button>
      <SettingsDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function rowToForm(row: AppSettingsRow): SettingsForm {
  return {
    anthropicApiKey: row.anthropicApiKey ?? '',
    anthropicBaseUrl: row.anthropicBaseUrl ?? '',
    openaiApiKey: row.openaiApiKey ?? '',
    deepseekApiKey: row.deepseekApiKey ?? '',
    arkApiKey: row.arkApiKey ?? '',
    deploymentPublishEnabled: row.deploymentPublishEnabled,
    deploymentPublishDir: row.deploymentPublishDir ?? '',
    deploymentPublicBaseUrl: row.deploymentPublicBaseUrl ?? '',
  }
}
