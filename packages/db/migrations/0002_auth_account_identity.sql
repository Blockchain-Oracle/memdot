-- One account row per sign-in identity (a wallet address, a recovery key). Better Auth's
-- generated schema leaves this pair unconstrained, and the wallet and recovery-code sign-in
-- plugins rely on it to stop two concurrent sign-ups from claiming the same identity.
CREATE UNIQUE INDEX "account_provider_identity_idx" ON "auth"."account" USING btree ("provider_id", "account_id");--> statement-breakpoint
-- Passkey sign-in looks credentials up by id; WebAuthn credential ids are globally unique.
CREATE UNIQUE INDEX "passkey_credential_unique_idx" ON "auth"."passkey" USING btree ("credential_id");
