"""The blind mailbox relay (ADR-0007, ADR-0019, ADR-0028).

Clients append opaque, padded blobs to a mailbox and read them back in the
relay's order. The relay keeps no accounts, no client addresses and no request
logs, and expires every row by the UTC day. The unguessable mailbox id is the
only capability (ADR-0073).
"""
