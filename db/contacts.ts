import { getDb } from "./index";

export type Contact = {
  id: number;
  name: string;
  ensName: string | null;
  address: string | null;
};

export type ContactInput = Omit<Contact, "id">;

const COLUMNS = "id, name, ens_name AS ensName, address";

export function listContacts(): Contact[] {
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM contacts ORDER BY name`)
    .all() as Contact[];
}

export function createContact(input: ContactInput): Contact {
  return getDb()
    .prepare(
      `INSERT INTO contacts (name, ens_name, address) VALUES (?, ?, ?) RETURNING ${COLUMNS}`,
    )
    .get(input.name, input.ensName, input.address) as Contact;
}

export function updateContact(id: number, input: ContactInput): Contact | undefined {
  return getDb()
    .prepare(
      `UPDATE contacts SET name = ?, ens_name = ?, address = ?, updated_at = unixepoch()
       WHERE id = ? RETURNING ${COLUMNS}`,
    )
    .get(input.name, input.ensName, input.address, id) as Contact | undefined;
}

export function deleteContact(id: number): boolean {
  return getDb().prepare("DELETE FROM contacts WHERE id = ?").run(id).changes > 0;
}
