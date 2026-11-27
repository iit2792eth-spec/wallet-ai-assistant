import { parseUnits } from "viem";
import { z } from "zod";
import { deleteLimit, getToken, setLimitEnabled, upsertLimit } from "@/db/limits";
import { jsonError, parseId, readBody } from "@/lib/http";
import { limitSchema } from "@/lib/validation";
import { changeGuard } from "@/lib/wallet-http";

type Ctx = RouteContext<"/api/limits/[tokenId]">;

async function findToken(ctx: Ctx) {
  const id = parseId((await ctx.params).tokenId);
  return id === null ? undefined : getToken(id);
}

export async function PUT(request: Request, ctx: Ctx) {
  const guarded = await changeGuard(request, "limits");
  if (guarded) return guarded;
  const body = await readBody(request, limitSchema);
  if ("error" in body) return body.error;
  const token = await findToken(ctx);
  if (!token) return jsonError(404, "Token not found");

  const { perTxMax, dailyMax, weeklyMax, enabled } = body.data;
  const amounts = [perTxMax, dailyMax, weeklyMax];
  if (amounts.some((amount) => (amount.split(".")[1]?.length ?? 0) > token.decimals)) {
    return jsonError(400, `At most ${token.decimals} decimal places`);
  }
  const [perTx, daily, weekly] = amounts.map((amount) => parseUnits(amount, token.decimals));
  if (perTx > daily || daily > weekly) {
    return jsonError(400, "Limits must increase: per transaction ≤ daily ≤ weekly");
  }
  upsertLimit(token.id, {
    perTxMax: perTx.toString(),
    dailyMax: daily.toString(),
    weeklyMax: weekly.toString(),
    enabled,
  });
  return Response.json({ ok: true });
}

/** Turns a saved limit on or off; the amounts stay as they are. */
export async function PATCH(request: Request, ctx: Ctx) {
  const guarded = await changeGuard(request, "limits");
  if (guarded) return guarded;
  const body = await readBody(request, z.object({ enabled: z.boolean() }));
  if ("error" in body) return body.error;
  const token = await findToken(ctx);
  if (!token) return jsonError(404, "Token not found");
  if (!setLimitEnabled(token.id, body.data.enabled)) return jsonError(404, "Save a limit first");
  return Response.json({ ok: true });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const guarded = await changeGuard(request, "limits");
  if (guarded) return guarded;
  const token = await findToken(ctx);
  if (!token) return jsonError(404, "Token not found");
  deleteLimit(token.id);
  return Response.json({ ok: true });
}
