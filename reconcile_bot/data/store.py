from __future__ import annotations

import datetime
import json
import os
from typing import Dict, List, Optional, Set, Tuple

from .models import Document, Group, Proposal, Reconcile


class ReconcileStore:
    """Persistence layer for groups, documents and reconcile votes."""

    def __init__(self, path: str = "reconcile_data.json") -> None:
        self.path = path
        self.groups: Dict[str, Group] = {}
        self._load()

    # ---------- Persistence ----------
    def _load(self) -> None:
        if not os.path.exists(self.path):
            return
        with open(self.path, "r", encoding="utf-8") as f:
            data = json.load(f)

        groups: Dict[str, Group] = {}
        for gname, gdata in data.get("groups", {}).items():
            group = Group(
                name=gdata["name"],
                description=gdata["description"],
                tags=set(gdata.get("tags", [])),
                members=set(gdata.get("members", [])),
                documents={},
            )
            for doc_id_str, ddata in gdata.get("documents", {}).items():
                doc_id = int(doc_id_str)
                document = Document(
                    document_id=doc_id,
                    title=ddata["title"],
                    content=ddata["content"],
                    tags=set(ddata.get("tags", [])),
                    proposals={},
                )
                for prop_id_str, pdata in ddata.get("proposals", {}).items():
                    prop_id = int(prop_id_str)
                    proposal = Proposal(
                        proposal_id=prop_id,
                        author_id=int(pdata["author_id"]),
                        content=pdata["content"],
                        timestamp=float(pdata["timestamp"]),
                        votes={int(k): v for k, v in pdata.get("votes", {}).items()},
                        merged=bool(pdata.get("merged", False)),
                    )
                    document.proposals[prop_id] = proposal
                group.documents[doc_id] = document
            groups[gname] = group

        self.groups = groups

        # load reconciles
        self._reconciles: Dict[int, Reconcile] = {}
        for rid_str, rdata in data.get("reconciles", {}).items():
            rid = int(rid_str)
            rec = Reconcile(
                reconcile_id=rid,
                mode=rdata["mode"],
                a_side=rdata["a_side"],
                b_side=rdata["b_side"],
                guild_id=rdata["guild_id"],
                channel_id=rdata["channel_id"],
                thread_id=rdata.get("thread_id"),
                message_id=rdata.get("message_id"),
                created_ts=rdata["created_ts"],
                close_ts=rdata["close_ts"],
                closed=rdata.get("closed", False),
                cancelled=rdata.get("cancelled", False),
                reminded_24=rdata.get("reminded_24", False),
                reminded_1=rdata.get("reminded_1", False),
                votes={},
            )
            for uid_str, v in rdata.get("votes", {}).items():
                rec.votes[int(uid_str)] = __import__("types").SimpleNamespace(**v)
            self._reconciles[rid] = rec

    def _to_dict(self) -> Dict:
        groups_dict: Dict[str, Dict] = {}
        for name, group in self.groups.items():
            documents_dict: Dict[str, Dict] = {}
            for doc_id, doc in group.documents.items():
                proposals_dict: Dict[str, Dict] = {}
                for pid, prop in doc.proposals.items():
                    proposals_dict[str(pid)] = {
                        "author_id": prop.author_id,
                        "content": prop.content,
                        "timestamp": prop.timestamp,
                        "votes": {str(uid): v for uid, v in prop.votes.items()},
                        "merged": prop.merged,
                    }
                documents_dict[str(doc_id)] = {
                    "title": doc.title,
                    "content": doc.content,
                    "tags": list(doc.tags),
                    "proposals": proposals_dict,
                }
            groups_dict[name] = {
                "name": group.name,
                "description": group.description,
                "tags": list(group.tags),
                "members": list(group.members),
                "documents": documents_dict,
            }

        recs: Dict[str, Dict] = {}
        if hasattr(self, "_reconciles"):
            for rid, r in self._reconciles.items():
                recs[str(rid)] = {
                    "reconcile_id": r.reconcile_id,
                    "mode": r.mode,
                    "a_side": r.a_side,
                    "b_side": r.b_side,
                    "guild_id": r.guild_id,
                    "channel_id": r.channel_id,
                    "thread_id": r.thread_id,
                    "message_id": r.message_id,
                    "created_ts": r.created_ts,
                    "close_ts": r.close_ts,
                    "closed": r.closed,
                    "cancelled": r.cancelled,
                    "reminded_24": getattr(r, "reminded_24", False),
                    "reminded_1": getattr(r, "reminded_1", False),
                    "votes": {
                        str(uid): {
                            "voter_id": v.voter_id,
                            "side": v.side,
                            "score": v.score,
                            "timestamp": v.timestamp,
                        }
                        for uid, v in r.votes.items()
                    },
                }

        return {"groups": groups_dict, "reconciles": recs}

    def save(self) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._to_dict(), f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.path)

    # ---------- Group ops ----------
    def create_group(self, name: str, description: str, tags: List[str], creator_id: int) -> Optional[str]:
        if name in self.groups:
            return "A group with that name already exists."
        group = Group(name=name, description=description, tags=set(t.strip().lower() for t in tags))
        group.members.add(creator_id)
        self.groups[name] = group
        self.save()
        return None

    def join_group(self, name: str, user_id: int) -> Optional[str]:
        group = self.groups.get(name)
        if not group:
            return "Group not found."
        group.members.add(user_id)
        self.save()
        return None

    # ---------- Document ops ----------
    def create_document(self, group_name: str, title: str, tags: List[str], content: str) -> Optional[int]:
        group = self.groups.get(group_name)
        if not group:
            return None
        doc_id = group.next_document_id()
        document = Document(document_id=doc_id, title=title, content=content, tags=set(t.strip().lower() for t in tags))
        group.documents[doc_id] = document
        self.save()
        return doc_id

    def get_document(self, group_name: str, doc_id: int) -> Optional[Document]:
        group = self.groups.get(group_name)
        if not group:
            return None
        return group.documents.get(doc_id)

    def add_proposal(self, group_name: str, doc_id: int, author_id: int, content: str) -> Optional[int]:
        document = self.get_document(group_name, doc_id)
        if not document:
            return None
        pid = document.next_proposal_id()
        document.proposals[pid] = Proposal(
            proposal_id=pid,
            author_id=author_id,
            content=content,
            timestamp=datetime.datetime.utcnow().timestamp(),
            votes={},
            merged=False,
        )
        self.save()
        return pid

    def record_vote(self, group_name: str, doc_id: int, prop_id: int, user_id: int, vote: str) -> Optional[str]:
        if vote not in {"accept", "reject"}:
            return "Invalid vote."
        document = self.get_document(group_name, doc_id)
        if not document:
            return "Document not found."
        proposal = document.proposals.get(prop_id)
        if not proposal:
            return "Proposal not found."
        if proposal.merged:
            return "This proposal has already been merged."

        # record vote
        proposal.votes[user_id] = vote

        # merge rule: more accepts than rejects AND accepts >= ceil( |members| / 2 )
        group = self.groups[group_name]
        accepts = sum(1 for v in proposal.votes.values() if v == "accept")
        rejects = sum(1 for v in proposal.votes.values() if v == "reject")
        required = max(1, (len(group.members) + 1) // 2)  # simple majority threshold
        if accepts > rejects and accepts >= required:
            document.content = proposal.content
            proposal.merged = True
        self.save()
        return None

    # ---------- Recommendations ----------
    def recommendations_for(self, user_id: int, top_n: int = 5) -> List[str]:
        user_tags: Set[str] = set()
        for group in self.groups.values():
            if user_id in group.members:
                user_tags.update(group.tags)
        scores: List[Tuple[float, str]] = []
        for group in self.groups.values():
            if user_id in group.members:
                continue
            if not group.tags:
                continue
            if not user_tags:
                continue
            inter = user_tags & group.tags
            union = user_tags | group.tags
            score = len(inter) / len(union) if union else 0.0
            scores.append((score, group.name))
        scores.sort(key=lambda x: x[0], reverse=True)
        return [name for score, name in scores[:top_n] if score > 0.0]

    # ---------- Reconcile Persistence ----------
    def next_reconcile_id(self) -> int:
        return max((r.get("reconcile_id", 0) for r in self._raw_reconciles()), default=0) + 1

    def _raw_reconciles(self):
        # for migration from file
        if not hasattr(self, "_reconciles"):
            self._reconciles = {}
        return self._reconciles.values()

    def _ensure_reconciles_loaded(self):
        if not hasattr(self, "_reconciles"):
            self._reconciles = {}

    def create_reconcile(self, mode: str, a_side: str, b_side: str, guild_id: int, channel_id: int, duration_hours: int = 72):
        self._ensure_reconciles_loaded()
        rid = self.next_reconcile_id()
        now = datetime.datetime.utcnow().timestamp()
        close_ts = now + duration_hours * 3600
        rec = Reconcile(
            reconcile_id=rid,
            mode=mode,
            a_side=a_side,
            b_side=b_side,
            guild_id=guild_id,
            channel_id=channel_id,
            thread_id=None,
            message_id=None,
            created_ts=now,
            close_ts=close_ts,
            closed=False,
            cancelled=False,
            votes={},
        )
        self._reconciles[rid] = rec
        self.save()
        return rid

    def set_reconcile_message(self, rid: int, thread_id: int, message_id: int):
        if not hasattr(self, "_reconciles"):
            return
        rec = self._reconciles.get(rid)
        if rec:
            rec.thread_id = thread_id
            rec.message_id = message_id
            self.save()

    def get_reconcile(self, rid: int):
        if not hasattr(self, "_reconciles"):
            return None
        return self._reconciles.get(rid)

    def list_open_reconciles(self):
        if not hasattr(self, "_reconciles"):
            return []
        return [r for r in self._reconciles.values() if not r.closed and not r.cancelled]

    def record_reconcile_vote(self, rid: int, voter_id: int, side: str, score: int) -> Optional[str]:
        if not hasattr(self, "_reconciles"):
            return "No such vote."
        rec = self._reconciles.get(rid)
        if not rec:
            return "Reconcile not found."
        if score < -2 or score > 2:
            return "Score must be between -2 and +2."
        rec.votes[voter_id] = __import__("types").SimpleNamespace(
            **{"voter_id": voter_id, "side": side, "score": score, "timestamp": datetime.datetime.utcnow().timestamp()}
        )
        self.save()
        return None

    def cancel_reconcile(self, rid: int) -> bool:
        rec = self.get_reconcile(rid)
        if not rec:
            return False
        rec.cancelled = True
        self.save()
        return True

    def close_reconcile(self, rid: int) -> bool:
        rec = self.get_reconcile(rid)
        if not rec:
            return False
        rec.closed = True
        self.save()
        return True

