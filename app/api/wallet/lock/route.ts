import { z } from "zod";
import { readBody } from "@/lib/http";
import { lockWallet } from "@/wallet";

export async function POST(request: Request) {
  const body = await readBody(request, z.object({}));
  if ("error" in body) return body.error;
  lockWallet("user");
  return Response.json({ ok: true });
}
