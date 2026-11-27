import { z } from "zod";
import { readBody } from "@/lib/http";
import { walletErrorResponse } from "@/lib/wallet-http";
import { createWallet } from "@/wallet";

const bodySchema = z.object({ password: z.string().min(8, "The password must be at least 8 characters").max(256) });

export async function POST(request: Request) {
  const body = await readBody(request, bodySchema);
  if ("error" in body) return body.error;
  try {
    return Response.json(await createWallet(body.data), { status: 201 });
  } catch (error) {
    return walletErrorResponse(error);
  }
}
