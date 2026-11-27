"use client";

import { ExternalLink } from "lucide-react";
import { Empty, ErrorText, Page } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ActivityRow } from "@/db/activity";
import { useApi } from "@/hooks/use-api";
import { formatAmount, formatTime, shortAddress } from "@/lib/format";

const FAILED = new Set(["failed", "blocked", "rejected", "expired"]);

function StatusBadge({ status }: { status: string }) {
  if (FAILED.has(status)) return <Badge variant="destructive">{status}</Badge>;
  if (status === "confirmed" || status === "signed") return <Badge variant="secondary">{status}</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export default function ActivityPage() {
  const { data, error } = useApi<ActivityRow[]>("/api/activity");

  return (
    <Page title="Activity">
      <p className="text-xs text-muted-foreground">Only actions made through this app.</p>
      <ErrorText>{error}</ErrorText>
      {data?.length === 0 && <Empty>No activity</Empty>}
      {data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="text-muted-foreground">{formatTime(row.createdAt)}</TableCell>
                <TableCell>{row.kind === "transfer" ? "Transfer" : row.kind === "swap" ? "Swap" : `Sign ${row.primaryType ?? ""}`}</TableCell>
                <TableCell className="font-mono">
                  {row.amount !== null && row.decimals !== null
                    ? `${formatAmount(row.amount, row.decimals)} ${row.symbol}`
                    : "—"}
                  {row.kind === "swap" && row.decimalsOut !== null && (row.amountOut ?? row.minOut) !== null && (
                    <span className="text-muted-foreground">
                      {" → "}
                      {row.amountOut === null && "≥ "}
                      {formatAmount((row.amountOut ?? row.minOut)!, row.decimalsOut)} {row.symbolOut}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {row.toAddress ? (
                    <span title={row.toAddress}>
                      {row.toLabel ?? <span className="font-mono">{shortAddress(row.toAddress)}</span>}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell className="text-right">
                  {row.txHash && row.explorerUrl && (
                    <a
                      href={`${row.explorerUrl}/tx/${row.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="View transaction"
                      className="inline-flex text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Page>
  );
}
