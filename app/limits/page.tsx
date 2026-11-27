"use client";

import { useState } from "react";
import { LockedNotice } from "@/components/locked-notice";
import { ErrorText, Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TokenLimit } from "@/db/limits";
import { useApi } from "@/hooks/use-api";
import { useChangesLocked } from "@/hooks/use-wallet";
import { api, errorMessage } from "@/lib/client";
import { formatAmount } from "@/lib/format";

const FIELDS = [
  { key: "perTxMax", label: "Per transaction" },
  { key: "dailyMax", label: "Daily" },
  { key: "weeklyMax", label: "Weekly" },
] as const;

function LimitRow({ limit, locked, onChanged }: { limit: TokenLimit; locked: boolean; onChanged: () => Promise<void> }) {
  const initial = (value: string | null) => (value === null ? "" : formatAmount(value, limit.decimals));
  const [values, setValues] = useState({
    perTxMax: initial(limit.perTxMax),
    dailyMax: initial(limit.dailyMax),
    weeklyMax: initial(limit.weeklyMax),
  });
  const [enabled, setEnabled] = useState(limit.perTxMax === null ? true : limit.enabled);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLimit = limit.perTxMax !== null;

  async function run(request: Promise<unknown>) {
    try {
      await request;
      setError(null);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  // The switch saves on its own; unsaved amounts in the inputs are left as they are.
  async function toggle(next: boolean) {
    setEnabled(next);
    setToggling(true);
    try {
      await api("PATCH", `/api/limits/${limit.tokenId}`, { enabled: next });
      setError(null);
    } catch (e) {
      setEnabled(!next);
      setError(errorMessage(e));
    } finally {
      setToggling(false);
    }
  }

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{limit.symbol}</TableCell>
        {FIELDS.map(({ key, label }) => (
          <TableCell key={key}>
            <Input
              aria-label={`${limit.symbol} ${label}`}
              className="w-28 font-mono"
              inputMode="decimal"
              placeholder="—"
              disabled={locked}
              value={values[key]}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            />
          </TableCell>
        ))}
        <TableCell>
          <Switch
            aria-label={`${limit.symbol} enabled`}
            title={hasLimit ? undefined : "Save a limit first"}
            checked={enabled}
            disabled={locked || !hasLimit || toggling}
            onCheckedChange={(next) => void toggle(next)}
          />
        </TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-2">
            {hasLimit && (
              <Button variant="ghost" disabled={locked} onClick={() => void run(api("DELETE", `/api/limits/${limit.tokenId}`))}>
                Clear
              </Button>
            )}
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => void run(api("PUT", `/api/limits/${limit.tokenId}`, { ...values, enabled }))}
            >
              Save
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {error && (
        <TableRow>
          <TableCell colSpan={6}>
            <ErrorText>{error}</ErrorText>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default function LimitsPage() {
  const { data, error, reload } = useApi<TokenLimit[]>("/api/limits");
  const locked = useChangesLocked();

  return (
    <Page title="Limits">
      <p className="text-xs text-muted-foreground">Transfers within all three limits are signed without asking.</p>
      <LockedNotice locked={locked} />
      <ErrorText>{error}</ErrorText>
      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              {FIELDS.map(({ key, label }) => (
                <TableHead key={key}>{label}</TableHead>
              ))}
              <TableHead>Enabled</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((limit) => (
              // Re-create the row when saved amounts change so the inputs show what was stored.
              // Not keyed on enabled: toggling must not wipe amounts being edited.
              <LimitRow
                key={`${limit.tokenId}:${limit.perTxMax}:${limit.dailyMax}:${limit.weeklyMax}`}
                limit={limit}
                locked={locked}
                onChanged={reload}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </Page>
  );
}
