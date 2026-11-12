### Recovery shares

#109 builds the shares and #118 the alert and cancel (§3, Recovery contacts and Recovering with contacts).

| Type | Body | Valid when | Built by |
|---|---|---|---|
| `recovery-share` | `{box}`: one share sealed to one contact, in unpadded base64url; it names no recipient, and any other field is dropped | it is in a group's log (a coalition's takes none, §4, Coalitions), and the author is a current member, suspended or not, whom no passed removal names (#115). It changes no Atom, Proposal, member, seat or opt-in: the fold only keeps it in `recoveryShares` | #109 |
| `recovery-alert` | `{box}`: a contact's approval, sealed to the person it warns, in unpadded base64url; it names no one, and any other field is dropped | as `recovery-share`. It changes nothing: the fold only keeps it in `recoveryAlerts`, with its receipt, from which the contact's 72 hours run | #118 |
| `recovery-cancel` | `{alert}`: the 16-byte tag sealed in the alert it answers, in canonical unpadded base64url, never the alert's event id; any other field is dropped | as `recovery-share`. It changes nothing: the fold only keeps it in `recoveryCancels`, and only the contact's device decides whether it counts, by its author | #118 |

- Golden vectors: `vectors/recovery-share.json`, `vectors/recovery-alert.json`, `vectors/recovery-cancel.json` and the coalition logs' `recovery-share-coalition.json` and `recovery-alert-coalition.json`, and fast-check properties that each of the three from anyone, anywhere in a log, changes nothing but its own list, and that one after a dissolve is ignored.
- None of the three expires with a Proposal's ballots (#111): they belong to no Proposal, so `EXPIRES_WITH_BALLOTS` can't list them. A device's log keeps them, and the relay drops them with the rest of the mailbox after 30 days.
