"use client";

import { useEffect, useState } from "react";
import { ErrorText, Field } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { announceWalletChange } from "@/hooks/use-wallet";
import { api, errorMessage } from "@/lib/client";

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** Shared form shell: submits once, shows the server's message on failure, clears secrets on close. */
function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(request: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await request();
      announceWalletChange();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, submit };
}

function Footer({ busy, label, onCancel, hideCancel = false }: { busy: boolean; label: string; onCancel: () => void; hideCancel?: boolean }) {
  return (
    <DialogFooter>
      {!hideCancel && (
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Working…" : label}
      </Button>
    </DialogFooter>
  );
}

function NewPasswordFields({ password, confirm, onPassword, onConfirm }: {
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
}) {
  return (
    <>
      <Field label="Password (at least 8 characters)" htmlFor="wallet-password">
        <Input id="wallet-password" type="password" autoComplete="new-password" value={password} onChange={(e) => onPassword(e.target.value)} required />
      </Field>
      <Field label="Confirm password" htmlFor="wallet-confirm">
        <Input id="wallet-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => onConfirm(e.target.value)} required />
      </Field>
    </>
  );
}

function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < 8) return "The password must be at least 8 characters.";
  if (password !== confirm) return "The passwords do not match.";
  return null;
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { busy, error, setError, submit } = useSubmit(onClose);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = passwordProblem(password, confirm);
        if (problem) return setError(problem);
        void submit(() => api("POST", "/api/wallet/create", { password }));
      }}
    >
      <DialogHeader>
        <DialogTitle>Create wallet</DialogTitle>
      </DialogHeader>
      <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
      <p className="text-xs text-muted-foreground">The key cannot be exported. Use it for test funds only.</p>
      <ErrorText>{error}</ErrorText>
      <Footer busy={busy} label="Create" onCancel={onClose} />
    </form>
  );
}

function ImportForm({ onClose }: { onClose: () => void }) {
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { busy, error, setError, submit } = useSubmit(onClose);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = passwordProblem(password, confirm);
        if (problem) return setError(problem);
        void submit(() => api("POST", "/api/wallet/import", { secret, password }));
      }}
    >
      <DialogHeader>
        <DialogTitle>Import wallet</DialogTitle>
      </DialogHeader>
      <Field label="Private key or seed phrase" htmlFor="wallet-secret">
        <Textarea
          id="wallet-secret"
          rows={3}
          className="min-h-20 min-w-0 resize-none field-sizing-fixed font-mono text-xs break-all"
          autoComplete="off"
          spellCheck={false}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required
        />
      </Field>
      <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
      <ErrorText>{error}</ErrorText>
      <Footer busy={busy} label="Import" onCancel={onClose} />
    </form>
  );
}

function UnlockForm({ onClose, required = false }: { onClose: () => void; required?: boolean }) {
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(onClose);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => api("POST", "/api/wallet/unlock", { password }));
      }}
    >
      <DialogHeader>
        <DialogTitle>Unlock wallet</DialogTitle>
      </DialogHeader>
      <Field label="Password" htmlFor="wallet-unlock-password">
        <Input id="wallet-unlock-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
      </Field>
      <ErrorText>{error}</ErrorText>
      <Footer busy={busy} label="Unlock" onCancel={onClose} hideCancel={required} />
    </form>
  );
}

function RemoveForm({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(onClose);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => api("POST", "/api/wallet/remove", { password }));
      }}
    >
      <DialogHeader>
        <DialogTitle>Remove wallet</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        The key is deleted from this computer. It cannot be recovered unless you have it elsewhere.
      </p>
      <Field label="Password" htmlFor="wallet-remove-password">
        <Input id="wallet-remove-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
      </Field>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy ? "Working…" : "Remove"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// Each form is mounted only while its dialog is open, so typed secrets are discarded on close.
//
// When `required` (the wallet is locked), the dialog cannot be dismissed: it is a
// controlled dialog, so ignoring a close request keeps it open, which covers
// Escape, outside-press and the close button alike. A MutationObserver re-opens
// it if the popup node is torn out of the DOM.
//
// NOTE: this is a footgun / UX guard, NOT a security boundary. The real guard is
// the server: a locked wallet holds no key in memory and every signing path
// throws WALLET_LOCKED (see wallet/keystore.ts). Anyone in devtools can still
// defeat the client-side re-assert — but they cannot sign while locked, so it
// buys nothing to try harder here.
function WalletDialog({
  open,
  onOpenChange,
  required = false,
  children,
}: DialogProps & { required?: boolean; children: (close: () => void) => React.ReactNode }) {
  // Bumping this remounts the whole dialog, re-creating the portal if it was removed.
  const [remount, setRemount] = useState(0);

  useEffect(() => {
    if (!required || !open || typeof MutationObserver === "undefined") return;
    const present = () => document.querySelector('[data-required="true"]') !== null;
    const observer = new MutationObserver(() => {
      if (!present()) setRemount((n) => n + 1);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [required, open, remount]);

  return (
    <Dialog
      key={remount}
      open={open}
      // Refuse every close request while the wallet is locked.
      onOpenChange={(next) => {
        if (required && !next) return;
        onOpenChange(next);
      }}
      disablePointerDismissal={required}
    >
      <DialogContent showCloseButton={!required} data-required={required ? "true" : undefined} className="sm:max-w-lg">
        {open && children(() => onOpenChange(false))}
      </DialogContent>
    </Dialog>
  );
}

export const CreateWalletDialog = (props: DialogProps) => <WalletDialog {...props}>{(close) => <CreateForm onClose={close} />}</WalletDialog>;
export const ImportWalletDialog = (props: DialogProps) => <WalletDialog {...props}>{(close) => <ImportForm onClose={close} />}</WalletDialog>;
export const RemoveWalletDialog = (props: DialogProps) => <WalletDialog {...props}>{(close) => <RemoveForm onClose={close} />}</WalletDialog>;
export const UnlockWalletDialog = ({ required, ...props }: DialogProps & { required?: boolean }) => (
  <WalletDialog {...props} required={required}>
    {(close) => <UnlockForm onClose={close} required={required} />}
  </WalletDialog>
);

export async function lockWalletNow(): Promise<void> {
  await api("POST", "/api/wallet/lock", {}).catch(() => {});
  announceWalletChange();
}
