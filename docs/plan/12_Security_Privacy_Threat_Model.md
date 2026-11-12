# Security, Privacy, and Threat Model (The “Nazis / database” problem)

This doc is about the most existential critique raised so far: the possibility that Reconcile becomes a tool for surveillance, targeting, coercion, or social sorting.

## The devil’s advocate critique (verbatim)

> I love all the framework you’ve developed for doing a project like this, from the mission statement, to the planning doc.
>
> There’s still some ‘devils advocate’ questions I gotta pose to you about the Reconcile platform tho,
> It looks like you’ve come up with some (honestly genius) way to organise a *database* of people using… idk… ‘democracy’ lol.
> Ideological association becomes a key property for each user object.
>
> Its really clever- and you can say you are creating a substack/github thing… but that’s just ‘front-end’ talk.
> What you’re actually creating is a database of people, their ideologies, and the associations they derive from those ideologies
>
> The actual tech itself, for this to work in a truly ‘revolutionary’ way- would be a mesh-net type thing. So you go to your local occupy rally, and you can directly ‘reconcile’ with them, ‘sandboxed’ from any big brother-esque global database
>
> Otherwise- imagine how valuable

## What the critique is really saying

Even if Reconcile looks like “Substack + GitHub for mission statements,” it can be interpreted (and used) as:

- a database of humans,
- indexed by ideology / values / affiliations,
- linked through association graphs (who follows whom, who co-authors what, who reconciled with which group),
- and therefore extremely valuable to hostile actors.

The short version:
**Intent is not a security model.**

## The “Nazis” framing

You raised this under the umbrella of “speaking of Nazis,” which is blunt but accurate as a category marker:

- extremist movements historically benefit from lists,
- authoritarian regimes benefit from lists,
- corporate influence operations benefit from lists,
- and modern harassment campaigns benefit from lists.

If your system produces legible maps of human alignment, it can be inverted.

## The mesh-net / local-first direction

The critique proposes that to be “revolutionary” (trust-minimizing), the platform would want to be more like:

- local-first,
- peer-to-peer,
- mesh-net friendly,

so that reconciliation can happen “at your local occupy rally,” sandboxed from a centralized database.

Even without choosing a specific implementation, this establishes a **design tension** that is now part of the project:

- Centralization increases convenience, discoverability, and “global graph” power…
- …and also increases the blast radius of compromise and abuse.

## Threat model sketch (conceptual)

Potential adversaries:
- hostile states / law enforcement overreach,
- corporate data brokers,
- extremist groups,
- stalkers and harassers,
- ideological opponents running doxx campaigns,
- insiders abusing access.

Potential harms:
- doxxing by affiliation,
- intimidation of vulnerable communities,
- chilling effects on speech/association,
- manipulation of votes,
- infiltration and capture of organizations/coalitions,
- targeted propaganda via notification systems.

High-risk data types (conceptually):
- real identities linked to political/ideological alignment,
- membership lists,
- coalition graphs (who collaborates with whom),
- participation/voting records,
- location metadata (if ever added),
- private debate transcripts (if stored).

## What the passkey vault doesn't cover on a seized device

The passkey vault ([#95](https://github.com/Geoffe-Ga/reconcile/issues/95), [ADR-0008](../adr/0008-passkeys-and-social-recovery.md)) seals the device's keys: each group's secret, signing key and encryption key, the relay backup key, a shared Document's share keys, a sent application's reply keys, and a recovering device's request keys. A seized device that is still locked doesn't give up any of them. It does give up whatever the device keeps beside them in the clear ([#391](https://github.com/Geoffe-Ga/reconcile/issues/391)), and that is most of what this document calls high-risk data:
- each group's log, whose signed events hold members' names, Proposals and ballots;
- the person's recovery contacts list;
- a contact's held recovery code, which holds the recovering device's seed;
- the reply seeds of front-door applications a member's device has read.

That is by design for the MVP: [ADR-0073](../adr/0073-mvp-scope.md) defers the app lock and the padded vault ([ADR-0046](../adr/0046-padded-vault-and-panic-wipe.md)), leaving the phone's own lock and Erase. A test reads a locked device's database and confirms the list (`client/src/store/db.locked.test.ts`).

## Design principles implied by the critique (still open decisions)

Without specifying architecture, the critique pushes toward principles like:

- Data minimization: collect the least identifying info needed.
- Consent and control: make following/affiliation choices explicit and reversible.
- Compartmentalization: avoid a single global “list of everyone.”
- Privacy-preserving discovery: avoid making group membership trivially enumerable.
- Safety defaults: protect vulnerable participants by default.
- Auditability: make abuse detectable and accountable where possible.
- Community governance tools that include anti-capture mechanics.

## Key open questions created by this critique

- Is “ideological association” truly a first-class property of user objects, or is that an emergent artifact we should minimize?
- Can the system support reconciliation without centralizing a global identity graph?
- What is the minimum viable “reconcile with others” experience that does not create a doxxable database?
- How do we handle the paradox that transparency builds legitimacy, but transparency can also create targets?

This critique is not a footnote. It’s part of the definition of Reconcile now: **a reconciliation tool must defend against weaponization.**
