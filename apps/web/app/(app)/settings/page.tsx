"use client";

import { addressOf, toBytes } from "@memdot/chain";
import { DEFAULT_DISPLAY_NAME } from "@memdot/config";
import { MemDotError, type Passkey } from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Button } from "@memdot/ui/components/button";
import { CidText } from "@memdot/ui/components/cid-text";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@memdot/ui/components/dialog";
import { Identicon } from "@memdot/ui/components/identicon";
import { Input } from "@memdot/ui/components/input";
import { RecoveryCodeGrid } from "@memdot/ui/components/recovery-code-grid";
import { SegmentedControl } from "@memdot/ui/components/segmented-control";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, PlusIcon, WalletIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { WalletPicker } from "@/components/auth/wallet-picker";
import { ConfirmDialog } from "@/components/files/file-dialogs";
import { Page, PageHeader } from "@/components/page-header";
import { clearAuthFlow } from "@/lib/auth-flow";
import { describeError, isCancelled } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { ME_KEY, useMe } from "@/lib/session";

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Unlock methods" },
  { id: "appearance", label: "Appearance" },
  { id: "sessions", label: "Sessions" },
];
const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];
const NAME_MAX = 64;

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-h2">{title}</h2>
        {description && <p className="text-ui-sm text-text-3">{description}</p>}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface-1">{children}</div>
    </section>
  );
}

function Line({
  label,
  children,
  action,
}: {
  label: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-ui text-text-2">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        {children}
        {action}
      </div>
    </div>
  );
}

/** Adding a passkey or a new recovery code needs a sign-in from the last 15 minutes. */
function freshnessHint(error: unknown) {
  if (
    error instanceof MemDotError &&
    (error.code === "SESSION_NOT_FRESH" || error.status === 403)
  ) {
    toast.error(
      "For your safety, sign in again (within 15 minutes) before changing unlock methods.",
    );
    return true;
  }
  return false;
}

export default function SettingsPage() {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [removingWallet, setRemovingWallet] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [regenerate, setRegenerate] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [signOutAll, setSignOutAll] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (me?.user.name && me.user.name !== DEFAULT_DISPLAY_NAME) setName(me.user.name);
  }, [me?.user.name]);

  const passkeys = useQuery({ queryKey: ["passkeys"], queryFn: () => memdot.account.passkeys() });
  const unlock = useQuery({
    queryKey: ["unlock-methods"],
    queryFn: () => memdot.account.unlockMethods(),
  });
  const refreshMethods = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["passkeys"] }),
      queryClient.invalidateQueries({ queryKey: ["unlock-methods"] }),
      queryClient.invalidateQueries({ queryKey: ME_KEY }),
    ]);
  const unlocks = (credentialId: string) =>
    unlock.data?.some((w) => w.kind === "passkey" && w.id === credentialId);
  const vrf = unlock.data?.filter((w) => w.kind === "vrf") ?? [];

  const rename = useMutation({
    mutationFn: () => memdot.account.rename(name.trim()),
    onSuccess: async () => {
      toast.success("Name saved.");
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const addPasskey = useMutation({
    mutationFn: () => memdot.account.addPasskey(),
    onSuccess: async ({ prf }) => {
      toast.success(
        prf
          ? "Passkey added. It signs in and unlocks."
          : "Passkey added for sign-in. This authenticator cannot unlock.",
      );
      await refreshMethods();
    },
    onError: (error) => {
      if (!isCancelled(error) && !freshnessHint(error)) toast.error(describeError(error).title);
    },
  });

  const owner = me?.account?.ownerAccount ?? null;
  const ownerAddress = owner ? addressOf(owner) : null;

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Your profile, the ways you unlock your key, and how MemDot looks."
      />
      <div className="grid gap-8 lg:grid-cols-[180px_1fr]">
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-20 flex flex-col gap-1">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="block rounded-lg px-2.5 py-1.5 text-ui text-text-2 hover:bg-surface-2 hover:text-foreground"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-10">
          <Section
            id="profile"
            title="Profile"
            description="What MemDot knows about you. Your files and their names stay encrypted."
          >
            <Line label="Name">
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  rename.mutate();
                }}
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={NAME_MAX}
                  placeholder="Your name"
                  aria-label="Name"
                  className="w-48"
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={rename.isPending || !name.trim() || name.trim() === me?.user.name}
                >
                  Save
                </Button>
              </form>
            </Line>
            <Line label="Chain account">
              {owner ? (
                <span className="flex min-w-0 items-center gap-2">
                  <Identicon publicKey={toBytes(owner)} size={20} />
                  {me?.account?.evmAddress ? (
                    <CidText value={me.account.evmAddress} />
                  ) : (
                    ownerAddress && <CidText value={ownerAddress} />
                  )}
                </span>
              ) : (
                <Skeleton className="h-5 w-40" />
              )}
            </Line>
            <Line label="Sharing key">
              {me?.account?.encryptionKey ? (
                <CidText value={me.account.encryptionKey} head={10} tail={6} />
              ) : (
                <Skeleton className="h-5 w-40" />
              )}
            </Line>
            <Line label="Signs in with">
              <span className="text-ui-sm text-text-2">
                {me?.signIn.passkeys ?? 0} passkey{me?.signIn.passkeys === 1 ? "" : "s"} ·{" "}
                {me?.signIn.wallets.length ?? 0} wallet
                {me?.signIn.wallets.length === 1 ? "" : "s"} · recovery code
              </span>
            </Line>
          </Section>

          <Section
            id="security"
            title="Unlock methods"
            description="Each one opens your key on a device. The recovery code always works; keep it offline."
          >
            <div className="flex flex-col border-b border-border">
              <div className="flex items-center justify-between px-4 pt-3 pb-1">
                <span className="eyebrow">Passkeys</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => addPasskey.mutate()}
                  disabled={addPasskey.isPending}
                >
                  {addPasskey.isPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <PlusIcon data-icon="inline-start" />
                  )}
                  Add passkey
                </Button>
              </div>
              {passkeys.isPending ? (
                <Skeleton className="m-4 h-10" />
              ) : passkeys.data?.length === 0 ? (
                <p className="px-4 pb-3 text-ui-sm text-text-3">
                  No passkeys. Add one to sign in and unlock with one touch.
                </p>
              ) : (
                <ul>
                  {passkeys.data?.map((pk) => (
                    <li key={pk.id} className="flex items-center gap-3 px-4 py-2.5">
                      <KeyRoundIcon className="size-4 text-text-3" aria-hidden="true" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-ui">
                          {pk.name ||
                            (pk.deviceType === "multiDevice" ? "Synced passkey" : "This device")}
                        </span>
                        <span className="text-ui-sm text-text-3">
                          Added {formatRelative(pk.createdAt)} ·{" "}
                          {pk.backedUp ? "backed up" : "single device"}
                        </span>
                      </span>
                      <Badge variant="outline" className="font-normal">
                        {unlocks(pk.credentialID) ? "Signs in and unlocks" : "Sign-in only"}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger-fg"
                        onClick={() => setRemoving(pk)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex flex-col border-b border-border">
              <div className="flex items-center justify-between px-4 pt-3 pb-1">
                <span className="eyebrow">Wallet unlock</span>
                <Button variant="ghost" size="sm" onClick={() => setWalletOpen(true)}>
                  <PlusIcon data-icon="inline-start" /> Add wallet
                </Button>
              </div>
              {vrf.length === 0 ? (
                <p className="px-4 pb-3 text-ui-sm text-text-3">
                  Talisman and SubWallet can unlock with a key only this site can derive (signVrf).
                </p>
              ) : (
                <ul>
                  {vrf.map((w) => (
                    <li key={w.id} className="flex items-center gap-3 px-4 py-2.5">
                      <WalletIcon className="size-4 text-text-3" aria-hidden="true" />
                      <CidText value={w.id} className="flex-1" />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger-fg"
                        onClick={() => setRemovingWallet(w.id)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Line
              label="Recovery code"
              action={
                <Button variant="outline" size="sm" onClick={() => setRegenerate(true)}>
                  Regenerate
                </Button>
              }
            >
              <span className="text-ui-sm text-text-3">
                12 words · signs in and unlocks anywhere
              </span>
            </Line>
          </Section>

          <Section id="appearance" title="Appearance">
            <Line label="Theme">
              {mounted && (
                <SegmentedControl
                  label="Theme"
                  options={THEMES}
                  value={theme ?? "system"}
                  onValueChange={setTheme}
                />
              )}
            </Line>
          </Section>

          <Section id="sessions" title="Sessions" description="Where this account is signed in.">
            <Line
              label="Sign out everywhere"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  className="text-danger-fg"
                  onClick={() => setSignOutAll(true)}
                >
                  Sign out all
                </Button>
              }
            >
              <span className="text-ui-sm text-text-3">
                Every browser and script session, this one too
              </span>
            </Line>
          </Section>
        </div>
      </div>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this passkey?"
        description="It will no longer sign in or unlock. Your recovery code and other methods keep working."
        action="Remove passkey"
        onConfirm={async () => {
          if (removing) await memdot.account.removePasskey(removing);
          await refreshMethods();
        }}
      />
      <ConfirmDialog
        open={removingWallet !== null}
        onOpenChange={(open) => !open && setRemovingWallet(null)}
        title="Stop this wallet from unlocking?"
        description="It can no longer open your key. Signing in with it is unaffected."
        action="Remove"
        onConfirm={async () => {
          if (removingWallet) await memdot.account.removeWalletUnlock(removingWallet);
          await refreshMethods();
        }}
      />
      <Dialog open={walletOpen} onOpenChange={setWalletOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unlock with a wallet</DialogTitle>
            <DialogDescription>
              The wallet derives a key bound to this site. Only Talisman and SubWallet support it.
            </DialogDescription>
          </DialogHeader>
          <WalletPicker
            onWallet={async (wallet) => {
              await memdot.account.addWalletUnlock(wallet);
              toast.success("This wallet can now unlock your key.");
              setWalletOpen(false);
              await refreshMethods();
            }}
          />
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={regenerate}
        onOpenChange={setRegenerate}
        title="Regenerate your recovery code?"
        description="A new code is shown once. The old one stops working at once, for signing in and for unlocking."
        action="Regenerate"
        onConfirm={async () => {
          try {
            const { recoveryCode } = await memdot.account.regenerateRecoveryCode();
            setAcknowledged(false);
            setNewCode(recoveryCode);
          } catch (error) {
            if (!freshnessHint(error)) throw error;
          }
        }}
      />
      <Dialog
        open={newCode !== null}
        onOpenChange={(open) => !open && acknowledged && setNewCode(null)}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Your new recovery code</DialogTitle>
            <DialogDescription>
              Store it somewhere safe. MemDot cannot show it again.
            </DialogDescription>
          </DialogHeader>
          {newCode && (
            <RecoveryCodeGrid
              code={newCode}
              acknowledged={acknowledged}
              onAcknowledgedChange={setAcknowledged}
            />
          )}
          <DialogFooter>
            <Button disabled={!acknowledged} onClick={() => setNewCode(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={signOutAll}
        onOpenChange={setSignOutAll}
        title="Sign out everywhere?"
        description="Every session of this account ends, including this one and any script using a session. API keys keep working."
        action="Sign out all"
        onConfirm={async () => {
          await memdot.account.signOutEverywhere();
          clearAuthFlow();
          queryClient.clear();
          router.replace("/sign-in");
        }}
      />
    </Page>
  );
}
