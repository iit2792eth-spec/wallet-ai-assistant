import { connection } from "next/server";
import { walletErrorResponse } from "@/lib/wallet-http";
import { getWalletStatus } from "@/wallet";

export async function GET() {
  await connection();
  try {
    return Response.json(await getWalletStatus());
  } catch (error) {
    return walletErrorResponse(error);
  }
}
