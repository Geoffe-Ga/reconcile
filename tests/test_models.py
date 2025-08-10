from reconcile_bot.data.models import (
    Document,
    Group,
    Proposal,
    Reconcile,
    ReconcileVote,
)


def test_group_and_document_ids():
    g = Group(name="G", description="", tags=set())
    assert g.next_document_id() == 1
    g.documents[1] = Document(document_id=1, title="T", content="", tags=set())
    assert g.next_document_id() == 2

    d = Document(document_id=1, title="T", content="", tags=set())
    assert d.next_proposal_id() == 1
    d.proposals[1] = Proposal(proposal_id=1, author_id=1, content="", timestamp=0.0)
    assert d.next_proposal_id() == 2


def test_reconcile_helpers():
    r = Reconcile(
        reconcile_id=1,
        mode="group↔group",
        a_side="A",
        b_side="B",
        guild_id=1,
        channel_id=1,
        thread_id=None,
        message_id=None,
        created_ts=0.0,
        close_ts=1.0,
    )

    assert r.side_names() == ("A", "B")
    assert r.is_group_vs_group() is True
    assert r.is_solo_to_group() is False

    groups = {
        "A": Group(name="A", description="", tags=set(), members={1}),
        "B": Group(name="B", description="", tags=set(), members={2}),
    }
    assert r.side_for_member(1, groups) == ["A"]
    assert r.side_for_member(3, groups) is None

    # voting tallies
    r.votes[1] = ReconcileVote(voter_id=1, side="A", score=2, timestamp=0.0)
    r.votes[2] = ReconcileVote(voter_id=2, side="B", score=1, timestamp=0.0)
    tallies = r.tallies()
    assert tallies["A"] == (1, 2.0)
    assert tallies["B"] == (1, 1.0)
    assert r.passes() is True

    # solo to group
    r2 = Reconcile(
        reconcile_id=2,
        mode="solo→group",
        a_side="solo:1",
        b_side="B",
        guild_id=1,
        channel_id=1,
        thread_id=None,
        message_id=None,
        created_ts=0.0,
        close_ts=1.0,
    )
    groups["B"].members.add(3)
    assert r2.is_solo_to_group() is True
    assert r2.side_for_member(3, groups) == ["B"]
    r2.votes[3] = ReconcileVote(voter_id=3, side="B", score=1, timestamp=0.0)
    assert r2.passes() is True
