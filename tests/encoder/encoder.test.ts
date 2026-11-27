import { describe, expect, it } from "vitest";
import { MaskVault, clearVault, getVault, hasVault } from "@/text-encoder";

// Text Encoder (docs/Text_encoder.txt): deterministic pattern rules, a private mapping.

const user = { kind: "user" } as const;
const ADDRESS_1 = "0x1234567890123456789012345678901234567890";
const ADDRESS_2 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const KEY = "0x1234567890123456789012345678901234567890123456789012345678901234";
const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";

describe("specification example", () => {
  it("encodes example 1 exactly", () => {
    const vault = new MaskVault();
    const input = `Send 0.5 ETH from my wallet\n${ADDRESS_1}\nto ${ADDRESS_2}.\nMy private key is:\n${KEY}`;
    expect(vault.encode(input, user)).toBe(
      "Send 0.5 ETH from my wallet\n[WALLET_ADDRESS_1]\nto [WALLET_ADDRESS_2].\nMy private key is:\n[PRIVATE_KEY_1]",
    );
    expect(vault.restore("[WALLET_ADDRESS_1]")).toBe(ADDRESS_1);
    expect(vault.restore("[WALLET_ADDRESS_2]")).toBe(ADDRESS_2);
  });
});

describe("pattern ordering and boundaries", () => {
  it("never reads part of a private key as an address", () => {
    const encoded = new MaskVault().encode(`key ${KEY} end`, user);
    expect(encoded).toBe("key [PRIVATE_KEY_1] end");
  });

  it("recognises a private key without 0x", () => {
    expect(new MaskVault().encode(`key ${KEY.slice(2)}`, user)).toBe("key [PRIVATE_KEY_1]");
  });

  it("does not take 40 characters out of a longer hex run", () => {
    expect(new MaskVault().encode(`${ADDRESS_1}ff`, user)).toBe("[INVALID_ADDRESS_1]");
  });

  it("encodes an address next to punctuation", () => {
    expect(new MaskVault().encode(`(${ADDRESS_1}), "${ADDRESS_2}".`, user)).toBe('([WALLET_ADDRESS_1]), "[WALLET_ADDRESS_2]".');
  });
});

describe("secret types", () => {
  it("encodes a 12-word seed phrase", () => {
    expect(new MaskVault().encode(`my phrase is ${SEED} thanks`, user)).toBe("my phrase is [SEED_PHRASE_1] thanks");
  });

  it("encodes a seed phrase written with commas and line breaks", () => {
    expect(new MaskVault().encode(SEED.split(" ").join(",\n"), user)).toBe("[SEED_PHRASE_1]");
  });

  it("leaves fewer than 12 seed words alone", () => {
    const text = SEED.split(" ").slice(0, 11).join(" ");
    expect(new MaskVault().encode(text, user)).toBe(text);
  });

  it("never restores a private key or seed phrase", () => {
    const vault = new MaskVault();
    vault.encode(`${KEY} ${SEED}`, user);
    expect(vault.restore("[PRIVATE_KEY_1]")).toBeUndefined();
    expect(vault.restore("[SEED_PHRASE_1]")).toBeUndefined();
    expect(vault.displayDecode("[PRIVATE_KEY_1] [SEED_PHRASE_1]")).toBe("[PRIVATE_KEY_1] [SEED_PHRASE_1]");
  });
});

describe("additional types", () => {
  it("encodes ENS names, emails and phone numbers", () => {
    const encoded = new MaskVault().encode("pay vitalik.eth, mail me at a.b@example.com or call +91 98765 43210", user);
    expect(encoded).toBe("pay [ENS_NAME_1], mail me at [EMAIL_1] or call [PHONE_1]");
  });

  it("does not read amounts as phone numbers", () => {
    const text = "send 1000000 WEI and 0.5 ETH";
    expect(new MaskVault().encode(text, user)).toBe(text);
  });

  it("encodes a malformed address as an invalid address", () => {
    const vault = new MaskVault();
    expect(vault.encode("send 5 ETH to 0x8u8027580250249", user)).toBe("send 5 ETH to [INVALID_ADDRESS_1]");
    expect(vault.restore("[INVALID_ADDRESS_1]")).toBeUndefined();
    expect(vault.displayDecode("[INVALID_ADDRESS_1]")).toBe("0x8u8027580250249");
  });

  it("encodes a 39-character address typo as an invalid address", () => {
    expect(new MaskVault().encode(`to ${ADDRESS_1.slice(0, -1)}`, user)).toBe("to [INVALID_ADDRESS_1]");
  });

  it("keeps a placeholder issued for the same document when asked, and nothing else", () => {
    const vault = new MaskVault();
    const page = { kind: "web" as const, ref: "https://example.com/invoice" };
    vault.encode(`typed ${ADDRESS_1}`, user); // [WALLET_ADDRESS_1], from the user
    vault.encode(`pay ${ADDRESS_2}`, page); // [WALLET_ADDRESS_2], from the page
    expect(vault.encode("[WALLET_ADDRESS_2]", page, { keepOwn: true })).toBe("[WALLET_ADDRESS_2]");
    // A placeholder from another source is still neutralised, so a page cannot alias what the user typed.
    expect(vault.encode("[WALLET_ADDRESS_1]", page, { keepOwn: true })).toBe("[INVALID_ADDRESS_1]");
    expect(vault.encode("[WALLET_ADDRESS_2]", { kind: "web", ref: "https://other.example" }, { keepOwn: true })).toMatch(/INVALID_ADDRESS/);
    expect(vault.encode("[WALLET_ADDRESS_2]", page)).toMatch(/INVALID_ADDRESS/);
  });

  it("neutralises text that already looks like a placeholder", () => {
    const vault = new MaskVault();
    vault.encode(`to ${ADDRESS_1}`, user);
    // A page or user writing "[WALLET_ADDRESS_1]" must not alias the real one.
    expect(vault.encode("send to [WALLET_ADDRESS_1]", { kind: "web", ref: "https://example.com" })).toBe("send to [INVALID_ADDRESS_1]");
  });
});

describe("numbering and mapping", () => {
  it("gives the same value the same placeholder, regardless of case", () => {
    const vault = new MaskVault();
    expect(vault.encode(`${ADDRESS_2} and ${ADDRESS_2.toUpperCase().replace("0X", "0x")}`, user)).toBe("[WALLET_ADDRESS_1] and [WALLET_ADDRESS_1]");
  });

  it("keeps numbering across messages in a session", () => {
    const vault = new MaskVault();
    vault.encode(ADDRESS_1, user);
    expect(vault.encode(`${ADDRESS_2} ${ADDRESS_1}`, user)).toBe("[WALLET_ADDRESS_2] [WALLET_ADDRESS_1]");
  });

  it("is deterministic", () => {
    const text = `a ${ADDRESS_1} b ${KEY} c vitalik.eth`;
    expect(new MaskVault().encode(text, user)).toBe(new MaskVault().encode(text, user));
  });

  it("knows only the placeholders it created", () => {
    const vault = new MaskVault();
    vault.encode(ADDRESS_1, user);
    expect(vault.isKnownPlaceholder("[WALLET_ADDRESS_1]")).toBe(true);
    expect(vault.isKnownPlaceholder("[WALLET_ADDRESS_2]")).toBe(false);
  });

  it("never exposes the mapping through serialisation or enumeration", () => {
    const vault = new MaskVault();
    vault.encode(`${ADDRESS_1} ${KEY}`, user);
    const leaks = [JSON.stringify(vault), JSON.stringify({ vault }), String(Object.keys(vault)), JSON.stringify(Object.entries(vault))];
    for (const text of leaks) {
      expect(text).not.toContain(ADDRESS_1);
      expect(text).not.toContain(KEY);
    }
  });

  it("forgets everything when cleared", () => {
    const vault = getVault("encoder-test-session");
    vault.encode(ADDRESS_1, user);
    clearVault("encoder-test-session");
    expect(vault.restore("[WALLET_ADDRESS_1]")).toBeUndefined();
    expect(vault.isKnownPlaceholder("[WALLET_ADDRESS_1]")).toBe(false);
    expect(hasVault("encoder-test-session")).toBe(false);
  });
});

describe("pasted text", () => {
  it("records addresses from pasted text as seen in someone else's text, not typed", () => {
    const vault = new MaskVault();
    vault.encode(`Me: save ${ADDRESS_1} as rent`, { kind: "pasted" });
    expect(vault.seenIn(ADDRESS_1)).toEqual({ user: false, document: true });
    expect(vault.sourceOf(ADDRESS_1)).toBe("pasted");
  });
});
