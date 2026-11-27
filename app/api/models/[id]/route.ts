import { deleteModel, updateModel } from "@/db/models";
import { getSetting, setSetting } from "@/db/settings";
import { isUniqueViolation, jsonError, parseId, readBody } from "@/lib/http";
import { modelUpdateSchema } from "@/lib/validation";
import { changeGuard } from "@/lib/wallet-http";

export async function PATCH(request: Request, ctx: RouteContext<"/api/models/[id]">) {
  const guarded = await changeGuard(request, "models");
  if (guarded) return guarded;
  const id = parseId((await ctx.params).id);
  if (id === null) return jsonError(404, "Model not found");
  const body = await readBody(request, modelUpdateSchema);
  if ("error" in body) return body.error;
  try {
    if (!updateModel(id, body.data)) return jsonError(404, "Model not found");
    return Response.json({ ok: true });
  } catch (error) {
    if (isUniqueViolation(error)) return jsonError(409, "A model with this label already exists");
    throw error;
  }
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/models/[id]">) {
  const guarded = await changeGuard(request, "models");
  if (guarded) return guarded;
  const id = parseId((await ctx.params).id);
  if (id === null || !deleteModel(id)) return jsonError(404, "Model not found");
  if (getSetting("active_model_id") === String(id)) setSetting("active_model_id", "");
  return Response.json({ ok: true });
}
