import { deleteContact, updateContact } from "@/db/contacts";
import { isUniqueViolation, jsonError, parseId, readBody } from "@/lib/http";
import { contactSchema } from "@/lib/validation";
import { changeGuard } from "@/lib/wallet-http";

type Ctx = RouteContext<"/api/contacts/[id]">;

export async function PUT(request: Request, ctx: Ctx) {
  const guarded = await changeGuard(request, "contacts");
  if (guarded) return guarded;
  const id = parseId((await ctx.params).id);
  if (id === null) return jsonError(404, "Contact not found");
  const body = await readBody(request, contactSchema);
  if ("error" in body) return body.error;
  try {
    const contact = updateContact(id, body.data);
    return contact ? Response.json(contact) : jsonError(404, "Contact not found");
  } catch (error) {
    if (isUniqueViolation(error)) return jsonError(409, "A contact with this name already exists");
    throw error;
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const guarded = await changeGuard(request, "contacts");
  if (guarded) return guarded;
  const id = parseId((await ctx.params).id);
  if (id === null || !deleteContact(id)) return jsonError(404, "Contact not found");
  return Response.json({ ok: true });
}
