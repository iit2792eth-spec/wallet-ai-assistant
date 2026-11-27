import { connection } from "next/server";
import { createContact, listContacts } from "@/db/contacts";
import { isUniqueViolation, jsonError, readBody } from "@/lib/http";
import { contactSchema } from "@/lib/validation";
import { changeGuard } from "@/lib/wallet-http";

export async function GET() {
  await connection();
  return Response.json(listContacts());
}

export async function POST(request: Request) {
  const guarded = await changeGuard(request, "contacts");
  if (guarded) return guarded;
  const body = await readBody(request, contactSchema);
  if ("error" in body) return body.error;
  try {
    return Response.json(createContact(body.data), { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) return jsonError(409, "A contact with this name already exists");
    throw error;
  }
}
