import { connection } from "next/server";
import { listTokenLimits } from "@/db/limits";
import { getActiveNetwork } from "@/db/networks";

export async function GET() {
  await connection();
  return Response.json(listTokenLimits(getActiveNetwork().chainId));
}
