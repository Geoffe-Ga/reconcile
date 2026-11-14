# ADR-0030: Without Passkey PRF, a Device Key Plus Mandatory Recovery

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it; [ADR-0074](0074-mvp-scope-revised.md) restores part of it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-stack-details`, decision `keys-without-prf`
- **Refines:** [ADR-0008](0008-passkeys-and-social-recovery.md); resolves spec §9 spike 2

## Decision

- **PRF is the main path.** Where the passkey supports the PRF extension, its output wraps the root key. It works with iCloud Keychain on iOS 18.4+ and macOS 15+, Google Password Manager on Android, Windows Hello on current Windows 11, and 1Password.
  - **Amendment (2026-11-14, #389):** Safari 18.0–18.3 on a Mac isn't trusted either, and nothing is sealed under a passkey until the groups have a way back. See the amendment below.
- **Without PRF, a non-extractable WebCrypto key held by the browser wraps the root key.** That covers Bitwarden on iOS, Dashlane, NordPass, Microsoft's Edge manager, older Windows, and iOS before 18.4 (ADR-0042).
- **Social recovery setup is mandatory before joining any group**, on both paths.
- **PRF is detected at the first sign-in, not at creation**, because some providers return nothing at creation but work on sign-in.
- **A passphrase stretched with Argon2id is an opt-in extra**, never required.
- This replaces the spec's earlier fallback (a device PIN through Argon2id).

## Consequences

- On the device-key path, unlock isn't tied to biometrics on that device. The app lock (ADR-0018) still applies.
- Wiping browser data loses the device key, and recovery restores it.
- **On iOS 18.0–18.3, PRF isn't used even when offered**, because of known bugs there that could lose data.

## Amendment (2026-11-14): Mac Safari 18.0–18.3, and a Way Back Before Sealing (#389)

**Decided by the founder on 2026-11-14 ([#389](https://github.com/Geoffe-Ga/reconcile/issues/389)): options (a) and (c). Built as decided.**

### Context

#257's internal review of the passkey vault (finding F1) found a way to lose data, not a flaw in the construction:
- On macOS 15.0–15.3 (Safari 18.0–18.3), and from an iPhone on iOS 18.0–18.3 used through the browser's "use a phone" option, PRF can give different output than it later gives. Apple fixed it in iOS 18.4 and macOS 15.4.
- `prfTrusted` checked only iPhones and iPads, so those keys were sealed. After the update every unlock fails, and every group since the last backup file is lost.
- No user-agent check can see the OS of a phone used from another device. Reports say output can still differ after 18.4 (#389's S2).

### Options considered

- **(a) Deny Mac Safari 18.0–18.3.** Cheap, and it matches the iOS rule.
- **(b) Treat a cross-platform answer (a phone or a security key) as no PRF.** Against: it refuses security keys too, whose output is stable.
- **(c) Require a way back before sealing:** a backup file or recovery contacts. That's this ADR's mandatory recovery, which ADR-0074 relaxed, brought back for the one step where a passkey can lose everything.

(a) closes the known Mac case. (c) is the only guard against what a user agent can't see. (b) refuses too much.

### Decision

- **Mac Safari.** On a Mac without a touch screen, Safari's own `Version/18.0` to `18.3` gives `prfTrusted` false. The version is read only beside Safari's token and no other browser's, since a Mac's `10_15_7` is frozen. Chrome, Edge, Firefox and Opera name no Safari version, so their passkeys' answers decide, as before.
- **A way back before sealing.** The second tap seals only when the groups have one (`client/src/app/recoveryPath.ts`):
  - **Recovery contacts in force:** a plan this device chose that isn't superseded and still has `t` contacts in shared groups (#109), or the backup key of contacts chosen on another of the person's devices, as its split says (#272). Their relay backup keeps up with every later group.
  - **A backup file:** every group a backup keeps (founded here, not leaving or read-only) is marked saved. The mark is set only once a file holding that group was saved through the share sheet or a download, or the group came back from a file. So a file with every such group's keys has left this device.
  - A device with no such group has nothing to back up. It has no way back yet either.

  The way back is read after the passkey answers the second tap, never before it, so no store read comes between a tap and its one WebAuthn call. A passkey's answer without one locks nothing and says so.
- **The offer asks for a way back in the same step.** Nothing new is stored:
  - **On a device with no group,** as on every new one, the offer says it waits. Continue opens the app without an answer, so it comes back at a later launch once there's a group.
  - **With groups and no way back,** it shows Save a backup's own form first, and Choose recovery contacts instead, which also leaves it unanswered. Once a file is saved, the passkey's setup takes the form's place.
  - **In Settings,** one line sends the person to Save a backup and Recovery contacts above. Setup appears the moment either gives a way back.
- **A vault sealed before this stays sealed.** It unlocks as before and is never unsealed, silently or otherwise; there's still no way to turn a passkey off (#243). Settings shows a notice under "locked" asking for a backup file or recovery contacts, until there's a way back.
- **(b) is not taken.**

### Consequences

- What the device can't know: whether the person still has the file, or remembers its passphrase. A saved mark is the most it can see.
- A group joined after the keys are sealed isn't in any file until the person saves another. Group home's backup card already asks for one. Contacts' relay backup keeps up on its own, which is why contacts count first.
- **Residual risks, accepted for the pilot:**
  - Chrome or Edge on macOS 15.0–15.3 using iCloud Keychain, and a phone's passkey used through "use a phone", still seal when PRF answers. A user agent can't see either. The way back is what protects them.
  - A device whose way back lapses after sealing (a new group, or contacts it's time to choose again) stays sealed. Settings asks again, as for a vault from before this.
