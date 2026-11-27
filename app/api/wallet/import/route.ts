import { z } from "zod";
import { readBody } from "@/lib/http";
import { walletErrorResponse } from "@/lib/wallet-http";
import { importWallet } from "@/wallet";

const bodySchema = z.object({
  /** A private key (64 hex characters, with or without 0x) or a seed phrase. */
  secret: z.string().trim().min(1, "Enter a private key or seed phrase").max(1000),
  password: z.string().min(8, "The password must be at least 8 characters").max(256),
});

const PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

// The secret and password are passed straight to the wallet layer and never logged or returned.
export async function POST(request: Request) {
  const body = await readBody(request, bodySchema);
  if ("error" in body) return body.error;
  const { secret, password } = body.data;
  try {
    const result = PRIVATE_KEY.test(secret)
      ? await importWallet({ privateKey: secret, password })
      : await importWallet({ mnemonic: secret, password });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return walletErrorResponse(error);
  }
}
