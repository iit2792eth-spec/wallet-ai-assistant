import { z } from "zod";
import { readBody } from "@/lib/http";
import { walletErrorResponse } from "@/lib/wallet-http";
import { unlockWallet } from "@/wallet";

const bodySchema = z.object({ password: z.string().min(1, "Enter your password").max(256) });

export async function POST(request: Request) {
  const body = await readBody(request, bodySchema);
  if ("error" in body) return body.error;
  try {
    return Response.json(await unlockWallet(body.data));
  } catch (error) {
    return walletErrorResponse(error);
  }
}
