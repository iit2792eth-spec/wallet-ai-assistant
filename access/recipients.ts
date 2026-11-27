import { getAddress, isAddress, type Address } from "viem";
import { normalize } from "viem/ens";
import type { Provenance } from "@/approvals/types";
import { getDb } from "@/db";
import { getVault } from "@/text-encoder";
import { resolveEns } from "@/wallet";
import { looksLikeEnsName } from "./host";

// Turns the recipient the program wrote (address, ENS name or contact name)
// into an address, a label for the user, and its provenance.
//
// Provenance is decided from the final value, not from how the program got it:
// an address the user typed or a saved contact is trusted; one that came from a
// web page or PDF is external; anything else (for example read from history,
// where look-alike "address poisoning" entries appear) is untrusted.

export type Recipient = {
  to: Address | null;
  label?: string;
  provenance: Provenance;
  /** Why it could not be resolved. */
  problem?: string;
};

type ContactRow = { name: string; ensName: string | null; address: string | null };

function contactByName(name: string): ContactRow | undefined {
  return getDb()
    .prepare("SELECT name, ens_name AS ensName, address FROM contacts WHERE name = ? COLLATE NOCASE")
    .get(name) as ContactRow | undefined;
}

function contactByAddress(address: string): ContactRow | undefined {
  return getDb()
    .prepare("SELECT name, ens_name AS ensName, address FROM contacts WHERE address = ? COLLATE NOCASE")
    .get(address) as ContactRow | undefined;
}

function contactByEns(name: string): ContactRow | undefined {
  return getDb()
    .prepare("SELECT name, ens_name AS ensName, address FROM contacts WHERE ens_name = ? COLLATE NOCASE")
    .get(name) as ContactRow | undefined;
}

/**
 * In a request that read a web page or PDF, a value found in that document is
 * external even if it is also a saved contact or something the user typed:
 * the document is where this request took it from.
 */
function provenanceOf(sessionId: string, value: string, isContact: boolean, external: boolean): Provenance {
  const seen = getVault(sessionId).seenIn(value);
  if (external && seen.document) return "external";
  if (seen.user) return "user";
  if (isContact) return "contact";
  if (seen.document) return "external";
  return "untrusted";
}

async function resolveName(name: string): Promise<Address | null> {
  return (await resolveEns({ name })).address;
}

/** `external`: the current request read a web page or PDF. */
export async function resolveRecipient(sessionId: string, input: string, external = false): Promise<Recipient> {
  // An address.
  if (isAddress(input, { strict: false })) {
    const address = getAddress(input);
    const contact = contactByAddress(address);
    return { to: address, label: contact?.name, provenance: provenanceOf(sessionId, address, Boolean(contact), external) };
  }

  // An ENS name.
  if (looksLikeEnsName(input)) {
    let name: string;
    try {
      name = normalize(input);
    } catch {
      return { to: null, label: input, provenance: "untrusted", problem: `${input} is not a valid ENS name.` };
    }
    const contact = contactByEns(name);
    const address = await resolveName(name);
    const provenance = provenanceOf(sessionId, name, Boolean(contact), external);
    if (!address) return { to: null, label: name, provenance, problem: `The ENS name ${name} does not point to an address.` };
    return { to: address, label: contact ? `${contact.name} (${name})` : name, provenance };
  }

  // A saved contact's name.
  const contact = contactByName(input);
  if (!contact) {
    return {
      to: null,
      label: input,
      provenance: "untrusted",
      problem: `No saved contact is named "${input}". Add the contact, or use an address or ENS name.`,
    };
  }
  if (contact.address) {
    const address = getAddress(contact.address);
    return { to: address, label: contact.name, provenance: external && getVault(sessionId).seenIn(address).document ? "external" : "contact" };
  }
  const address = contact.ensName ? await resolveName(contact.ensName) : null;
  if (!address) return { to: null, label: contact.name, provenance: "contact", problem: `The ENS name saved for ${contact.name} does not point to an address.` };
  return { to: address, label: contact.name, provenance: "contact" };
}
