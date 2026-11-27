"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LockedNotice } from "@/components/locked-notice";
import { WalletSection } from "@/components/wallet-section";
import { ModePicker } from "@/components/theme-controls";
import { Empty, ErrorText, Field, Page, Section } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "@/hooks/use-api";
import { useChangesLocked } from "@/hooks/use-wallet";
import { api, errorMessage } from "@/lib/client";
import { DEFAULT_BASE_URLS, PROVIDERS, PROVIDER_LABELS, type ModelSummary, type Provider } from "@/lib/model-types";
import type { AppSettings } from "@/lib/settings-types";

function ModelForm({
  initial,
  httpsOnly,
  onClose,
  onSaved,
}: {
  initial?: ModelSummary;
  httpsOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    label: initial?.label ?? "",
    provider: initial?.provider ?? ("openai_compatible" as Provider),
    modelName: initial?.modelName ?? "",
    baseUrl: initial?.baseUrl ?? "",
    apiKey: "",
  });
  const [clearApiKey, setClearApiKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [key]: e.target.value });

  // A saved key is dropped when the endpoint changes (see db/models.ts updateModel).
  const endpointChanged =
    initial !== undefined && (form.provider !== initial.provider || form.baseUrl.trim() !== (initial.baseUrl ?? ""));
  const keepsSavedKey = initial?.hasApiKey === true && !endpointChanged && !clearApiKey;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (initial) await api("PATCH", `/api/models/${initial.id}`, { ...form, clearApiKey });
      else await api("POST", "/api/models", form);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{initial ? "Edit model" : "Add model"}</DialogTitle>
      </DialogHeader>
      <Field label="Label" htmlFor="model-label">
        <Input id="model-label" value={form.label} onChange={set("label")} required />
      </Field>
      <Field label="Provider" htmlFor="model-provider">
        <NativeSelect id="model-provider" className="w-full" value={form.provider} onChange={set("provider")}>
          {PROVIDERS.map((provider) => (
            <NativeSelectOption key={provider} value={provider}>
              {PROVIDER_LABELS[provider]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Model name" htmlFor="model-name">
        <Input id="model-name" className="font-mono" value={form.modelName} onChange={set("modelName")} required />
      </Field>
      <Field label="Base URL (optional)" htmlFor="model-base-url">
        <Input
          id="model-base-url"
          className="font-mono"
          value={form.baseUrl}
          onChange={set("baseUrl")}
          placeholder={DEFAULT_BASE_URLS[form.provider]}
        />
        {httpsOnly && !(form.baseUrl.trim() || DEFAULT_BASE_URLS[form.provider]).toLowerCase().startsWith("https://") && (
          <p className="text-xs text-warning">HTTPS only is on: requests to this endpoint will be refused.</p>
        )}
      </Field>
      <Field label="API key" htmlFor="model-api-key">
        <Input
          id="model-api-key"
          type="password"
          autoComplete="off"
          value={form.apiKey}
          onChange={set("apiKey")}
          placeholder={keepsSavedKey ? "Saved; leave empty to keep" : undefined}
        />
      </Field>
      {initial?.hasApiKey && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={clearApiKey || endpointChanged}
            disabled={endpointChanged}
            onChange={(e) => setClearApiKey(e.target.checked)}
          />
          {endpointChanged ? "Saved key removed (endpoint changed)" : "Remove saved key"}
        </label>
      )}
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
    </form>
  );
}

function Models({
  activeModelId,
  httpsOnly,
  locked,
  onChanged,
}: {
  activeModelId: number | null;
  httpsOnly: boolean;
  locked: boolean;
  onChanged: () => Promise<void>;
}) {
  const { data, error, reload } = useApi<ModelSummary[]>("/api/models");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ModelSummary | null>(null);
  const [deleting, setDeleting] = useState<ModelSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(request: Promise<unknown>) {
    try {
      await request;
      setActionError(null);
    } catch (e) {
      setActionError(errorMessage(e));
    }
    await Promise.all([reload(), onChanged()]);
  }

  return (
    <Section
      title="Model"
      action={
        <Button variant="outline" size="sm" disabled={locked} onClick={() => setAdding(true)}>
          <Plus />
          Add
        </Button>
      }
    >
      <ErrorText>{error ?? actionError}</ErrorText>
      {data?.length === 0 && <Empty>No models</Empty>}
      {data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>API key</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((model) => (
              <TableRow key={model.id}>
                <TableCell>{model.label}</TableCell>
                <TableCell>{PROVIDER_LABELS[model.provider]}</TableCell>
                <TableCell className="font-mono text-xs">{model.modelName}</TableCell>
                <TableCell className="text-muted-foreground">{model.hasApiKey ? "Saved" : "—"}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2">
                    {model.id === activeModelId ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={locked}
                        onClick={() => void run(api("PATCH", "/api/settings", { activeModelId: model.id }))}
                      >
                        Use
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" aria-label="Edit" disabled={locked} onClick={() => setEditing(model)}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Delete" disabled={locked} onClick={() => setDeleting(model)}>
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent showCloseButton={false}>
          {adding && (
            <ModelForm
              httpsOnly={httpsOnly}
              onClose={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                void Promise.all([reload(), onChanged()]);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent showCloseButton={false}>
          {editing && (
            <ModelForm
              key={editing.id}
              initial={editing}
              httpsOnly={httpsOnly}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void Promise.all([reload(), onChanged()]);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.label ?? "model"}?`}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          setDeleting(null);
          void run(api("DELETE", `/api/models/${deleting.id}`));
        }}
      />
    </Section>
  );
}

function NetworkSettings({
  network,
  httpsOnly,
  locked,
  onChanged,
}: {
  network: AppSettings["network"];
  httpsOnly: boolean;
  locked: boolean;
  onChanged: () => Promise<void>;
}) {
  const [rpcUrl, setRpcUrl] = useState(network.rpcUrl);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api("PATCH", "/api/settings", { rpcUrl });
      setError(null);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Section title="Network">
      <form onSubmit={save} className="flex flex-col gap-3">
        <div className="text-sm">
          {network.name} <span className="font-mono text-xs text-muted-foreground">{network.chainId}</span>
        </div>
        <Field label="RPC URL" htmlFor="rpc-url">
          <div className="flex gap-2">
            <Input id="rpc-url" className="font-mono" disabled={locked} value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} />
            <Button type="submit" variant="outline" disabled={locked || rpcUrl === network.rpcUrl}>
              Save
            </Button>
          </div>
          {httpsOnly && !rpcUrl.trim().toLowerCase().startsWith("https://") && (
            <p className="text-xs text-warning">HTTPS only is on: this RPC URL will be refused.</p>
          )}
        </Field>
        <ErrorText>{error}</ErrorText>
      </form>
    </Section>
  );
}

function SecuritySettings({
  httpsOnly,
  swapSlippage,
  locked,
  onChanged,
}: {
  httpsOnly: boolean;
  swapSlippage: number;
  locked: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slippage, setSlippage] = useState(String(swapSlippage));

  async function saveSlippage(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api("PATCH", "/api/settings", { swapSlippage: Number(slippage) });
      setError(null);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await api("PATCH", "/api/settings", { httpsOnly: next });
      setError(null);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Security">
      <label className="flex items-center justify-between gap-4 text-sm">
        <span className="flex flex-col gap-0.5">
          <span>HTTPS only</span>
          <span className="text-xs text-muted-foreground">Refuse models and web pages that use http://</span>
        </span>
        <Switch aria-label="HTTPS only" checked={httpsOnly} disabled={locked || busy} onCheckedChange={(next) => void toggle(next)} />
      </label>
      <form onSubmit={saveSlippage} className="flex items-center justify-between gap-4 text-sm">
        <label htmlFor="swap-slippage" className="flex flex-col gap-0.5">
          <span>Swap slippage</span>
          <span className="text-xs text-muted-foreground">Asking for more in a message needs an extra confirmation</span>
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="swap-slippage"
            className="w-20 text-right font-mono"
            inputMode="decimal"
            disabled={locked}
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
          />
          <span className="text-muted-foreground">%</span>
          <Button type="submit" variant="outline" size="sm" disabled={locked || Number(slippage) === swapSlippage}>
            Save
          </Button>
        </div>
      </form>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

export default function SettingsPage() {
  const { data: settings, error, reload } = useApi<AppSettings>("/api/settings");
  const locked = useChangesLocked();

  return (
    <Page title="Settings">
      <LockedNotice locked={locked} />
      <ErrorText>{error}</ErrorText>
      {settings && (
        <>
          <Models activeModelId={settings.activeModelId} httpsOnly={settings.httpsOnly} locked={locked} onChanged={reload} />
          <Separator />
          <NetworkSettings key={settings.network.rpcUrl} network={settings.network} httpsOnly={settings.httpsOnly} locked={locked} onChanged={reload} />
          <Separator />
          <SecuritySettings key={settings.swapSlippage} httpsOnly={settings.httpsOnly} swapSlippage={settings.swapSlippage} locked={locked} onChanged={reload} />
          <Separator />
          <WalletSection />
        </>
      )}
      <Separator />
      <Section title="Appearance">
        <div>
          <ModePicker />
        </div>
      </Section>
    </Page>
  );
}
