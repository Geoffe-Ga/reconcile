# Who Reconcile Is For

Reconcile started from political organizing, but it isn't only for that. Any group that keeps shared, living text (a mission, house rules, a vision, an agreement) and wants to change it together can use it. These are the communities the founder has wanted it for. Each needs something different from discoverability, privacy, and integrations, which is why those are per-group choices ([ADR-0038](adr/0038-optional-discovery.md), [ADR-0039](adr/0039-integrations-per-group-opt-in.md), [ADR-0040](adr/0040-group-opt-ins-are-governed.md)).

| Community | Shared text it might keep | Discoverability it probably wants | Why |
|-----------|---------------------------|-----------------------------------|-----|
| **Families**, such as both sides of the in-laws in one Slack or Discord | holiday plans, house rules, a family values statement | None: invite only | It's private by nature, and nobody outside needs to find it |
| **Creator and fan communities**, such as a Substack Discord or a podcast's Patreon Discord | community guidelines, a shared reading list, event plans | Often a public front door | Growth is welcome, and members already chose a public fandom |
| **Recovery fellowships**, such as Recovery Dharma chapters on WhatsApp | group agreements, meeting format, a chapter's guidelines | A front door at most, never a roster | Anonymity is a core tradition, and being identified as a member can do real harm |
| **Workplaces**, such as an anarchist or cooperative workplace running self-governance | a shared vision, roles, policies: leadership without leaders | None: invite only | Membership is employment; outsiders don't need in |
| **Movements and chapters**, such as DSA chapters or Occupy Wall Street working groups | platforms, demands, points of unity, coalition statements | A public front door for recruitment, with members strictly hidden | Recruitment matters, and so does surveillance and harassment risk (threat model) |

## What This Means for Design

- **Defaults are private.** A group opts into exposure. It's never opted out of it.
- **Language stays plain and domain-neutral** (`DESIGN.md` voice). A family shouldn't feel they've joined a parliament, and a chapter shouldn't feel they've joined a fan club.
- **Coalitions aren't only political.** Two families merging holiday plans, or two recovery chapters co-writing a joint event's guidelines, reconcile the same way two movements do.
- **The threat model still applies to everyone.** The most vulnerable group on the platform sets the floor for the protections every group gets.
