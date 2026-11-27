import { connection } from "next/server";
import { createModel, listModels } from "@/db/models";
import { getSetting, setSetting } from "@/db/settings";
import { isUniqueViolation, jsonError, readBody } from "@/lib/http";
import { modelSchema } from "@/lib/validation";
import { changeGuard } from "@/lib/wallet-http";

export async function GET() {
  await connection();
  return Response.json(listModels());
}

export async function POST(request: Request) {
  const guarded = await changeGuard(request, "models");
  if (guarded) return guarded;
  const body = await readBody(request, modelSchema);
  if ("error" in body) return body.error;
  try {
    const id = createModel(body.data);
    // The first model added becomes the active one.
    if (!getSetting("active_model_id")) setSetting("active_model_id", String(id));
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) return jsonError(409, "A model with this label already exists");
    throw error;
  }
}
