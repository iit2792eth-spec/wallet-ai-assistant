import { connection } from "next/server";
import { listActivity } from "@/db/activity";

export async function GET() {
  await connection();
  return Response.json(listActivity());
}
