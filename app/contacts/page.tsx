"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LockedNotice } from "@/components/locked-notice";
import { Empty, ErrorText, Field, Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Contact } from "@/db/contacts";
import { useApi } from "@/hooks/use-api";
import { useChangesLocked } from "@/hooks/use-wallet";
import { api, errorMessage } from "@/lib/client";

function ContactForm({
  contact,
  onClose,
  onSaved,
}: {
  contact: Contact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(contact?.name ?? "");
  const [ensName, setEnsName] = useState(contact?.ensName ?? "");
  const [address, setAddress] = useState(contact?.address ?? "");
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      const body = { name, ensName, address };
      if (contact) await api("PUT", `/api/contacts/${contact.id}`, body);
      else await api("POST", "/api/contacts", body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{contact ? "Edit contact" : "Add contact"}</DialogTitle>
      </DialogHeader>
      <Field label="Name" htmlFor="contact-name">
        <Input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="ENS name" htmlFor="contact-ens">
        <Input id="contact-ens" value={ensName} onChange={(e) => setEnsName(e.target.value)} placeholder="name.eth" />
      </Field>
      <Field label="Address" htmlFor="contact-address">
        <Input
          id="contact-address"
          className="font-mono"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
        />
      </Field>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
    </form>
  );
}

export default function ContactsPage() {
  const { data, error, reload } = useApi<Contact[]>("/api/contacts");
  const locked = useChangesLocked();
  // undefined: closed, null: adding, Contact: editing
  const [editing, setEditing] = useState<Contact | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Contact | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function remove(contact: Contact) {
    setDeleting(null);
    try {
      await api("DELETE", `/api/contacts/${contact.id}`);
      setActionError(null);
    } catch (e) {
      setActionError(errorMessage(e));
    }
    await reload();
  }

  return (
    <Page
      title="Contacts"
      action={
        <Button variant="outline" disabled={locked} onClick={() => setEditing(null)}>
          <Plus />
          Add
        </Button>
      }
    >
      <LockedNotice locked={locked} />
      <ErrorText>{error ?? actionError}</ErrorText>
      {data?.length === 0 && <Empty>No contacts</Empty>}
      {data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>ENS</TableHead>
              <TableHead>Address</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((contact) => (
              <TableRow key={contact.id}>
                <TableCell>{contact.name}</TableCell>
                <TableCell>{contact.ensName ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs">{contact.address ?? "—"}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon-sm" aria-label="Edit" disabled={locked} onClick={() => setEditing(contact)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Delete" disabled={locked} onClick={() => setDeleting(contact)}>
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={editing !== undefined} onOpenChange={(open) => !open && setEditing(undefined)}>
        <DialogContent showCloseButton={false}>
          {editing !== undefined && (
            <ContactForm
              key={editing?.id ?? "new"}
              contact={editing}
              onClose={() => setEditing(undefined)}
              onSaved={() => {
                setEditing(undefined);
                void reload();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? "contact"}?`}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </Page>
  );
}
