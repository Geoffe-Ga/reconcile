from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, Set

@dataclass
class Proposal:
    proposal_id: int
    author_id: int
    content: str
    timestamp: float
    votes: Dict[int, str] = field(default_factory=dict)  # 'accept' | 'reject'
    merged: bool = False

@dataclass
class Document:
    document_id: int
    title: str
    content: str
    tags: Set[str]
    proposals: Dict[int, Proposal] = field(default_factory=dict)

    def next_proposal_id(self) -> int:
        return max(self.proposals.keys(), default=0) + 1

@dataclass
class Group:
    name: str
    description: str
    tags: Set[str]
    members: Set[int] = field(default_factory=set)
    documents: Dict[int, Document] = field(default_factory=dict)

    def next_document_id(self) -> int:
        return max(self.documents.keys(), default=0) + 1

from typing import Optional, List, Tuple

@dataclass
class ReconcileSide:
    name: str  # group name or "solo:<user_id>"
    voters: Set[int] = field(default_factory=set)

@dataclass
class ReconcileVote:
    voter_id: int
    side: str          # group name they are voting "as"
    score: int         # -2..+2
    timestamp: float

@dataclass
class Reconcile:
    reconcile_id: int
    mode: str                  # "group↔group" or "solo→group"
    a_side: str                # group name or "solo:<user_id>"
    b_side: str                # group name (target) or "" for solo? (kept in b_side)
    guild_id: int
    channel_id: int            # #reconcile-votes channel id (parent channel)
    thread_id: Optional[int]   # thread id if created
    message_id: Optional[int]  # id of the tally message with buttons
    created_ts: float
    close_ts: float
    closed: bool = False
    cancelled: bool = False
    reminded_24: bool = False
    reminded_1: bool = False
    votes: Dict[int, ReconcileVote] = field(default_factory=dict)  # keyed by voter_id

    def side_names(self) -> Tuple[str, str]:
        return (self.a_side, self.b_side)

    def is_group_vs_group(self) -> bool:
        return self.mode == "group↔group"

    def is_solo_to_group(self) -> bool:
        return self.mode == "solo→group"

    def side_for_member(self, user_id: int, groups: Dict[str, Group]) -> Optional[List[str]]:
        """Return which sides the user is eligible to vote as."""
        sides = []
        if self.is_group_vs_group():
            a = groups.get(self.a_side)
            b = groups.get(self.b_side)
            if a and user_id in a.members: sides.append(self.a_side)
            if b and user_id in b.members: sides.append(self.b_side)
        else:
            # solo -> group : only members of target group vote
            b = groups.get(self.b_side)
            if b and user_id in b.members: sides.append(self.b_side)
        return sides or None

    def tallies(self) -> Dict[str, Tuple[int, float]]:
        # returns {side: (count, average)}
        result: Dict[str, Tuple[int, float]] = {}
        acc: Dict[str, List[int]] = {}
        for v in self.votes.values():
            acc.setdefault(v.side, []).append(v.score)
        for side, scores in acc.items():
            if scores:
                result[side] = (len(scores), sum(scores)/len(scores))
        # ensure both sides present
        for s in [self.a_side, self.b_side]:
            result.setdefault(s, (0, 0.0))
        return result

    def passes(self) -> bool:
        t = self.tallies()
        # must have at least one vote on required side(s)
        if self.is_group_vs_group():
            c1, a1 = t[self.a_side]
            c2, a2 = t[self.b_side]
            return c1 > 0 and c2 > 0 and a1 > 0.0 and a2 > 0.0
        else:
            c2, a2 = t[self.b_side]
            return c2 > 0 and a2 > 0.0

