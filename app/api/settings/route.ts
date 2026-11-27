import { connection } from "next/server";
import { z } from "zod";
import { modelExists } from "@/db/models";
import { getActiveNetwork, setRpcUrl } from "@/db/networks";
import { getSetting, setSetting } from "@/db/settings";
import { jsonError, readBody } from "@/lib/http";
import { HTTPS_ONLY_KEY, isHttpsOnly } from "@/lib/https-only";
import { settingsSlippageBps } from "@/access/slippage";
import { audit } from "@/lib/logger";
import type { AppSettings } from "@/lib/settings-types";
import { rpcUrlSchema } from "@/lib/validation";
import { changeGuard } from "@/lib/wallet-http";

function readSettings(): AppSettings {
  const modelId = Number(getSetting("active_model_id"));
  const { chainId, name, rpcUrl } = getActiveNetwork();
  return {
    activeModelId: modelId > 0 && modelExists(modelId) ? modelId : null,
    network: { chainId, name, rpcUrl },
    httpsOnly: isHttpsOnly(),
    swapSlippage: settingsSlippageBps() / 100,
  };
}

export async function GET() {
  await connection();
  return Response.json(readSettings());
}

const patchSchema = z.object({
  activeModelId: z.number().int().positive().optional(),
  rpcUrl: rpcUrlSchema.optional(),
  httpsOnly: z.boolean().optional(),
  /** Percent, 0.01–50, at most two decimals. */
  swapSlippage: z.number().min(0.01).max(50).multipleOf(0.01).optional(),
});

export async function PATCH(request: Request) {
  const guarded = await changeGuard(request, "settings");
  if (guarded) return guarded;
  const body = await readBody(request, patchSchema);
  if ("error" in body) return body.error;
  const { activeModelId, rpcUrl, httpsOnly, swapSlippage } = body.data;

  if (activeModelId !== undefined && !modelExists(activeModelId)) {
    return jsonError(404, "Model not found");
  }
  // An http RPC URL is refused while HTTPS only is on (or is being turned on in the same change).
  if (rpcUrl !== undefined && (httpsOnly ?? isHttpsOnly()) && new URL(rpcUrl).protocol !== "https:") {
    return jsonError(400, "This RPC URL is not https, and HTTPS only is on. Use an https:// RPC URL, or turn HTTPS only off first.");
  }
  if (activeModelId !== undefined) setSetting("active_model_id", String(activeModelId));
  if (rpcUrl !== undefined) setRpcUrl(getActiveNetwork().chainId, rpcUrl);
  if (swapSlippage !== undefined) {
    const bps = Math.round(swapSlippage * 100);
    if (bps !== settingsSlippageBps()) {
      setSetting("swap_slippage_bps", String(bps));
      audit("setting_changed", { setting: "swap_slippage_bps", value: bps });
    }
  }
  if (httpsOnly !== undefined && httpsOnly !== isHttpsOnly()) {
    setSetting(HTTPS_ONLY_KEY, httpsOnly ? "1" : "0");
    audit("setting_changed", { setting: HTTPS_ONLY_KEY, value: httpsOnly });
  }
  return Response.json(readSettings());
}
