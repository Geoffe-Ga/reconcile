from reconcile_bot.data.store import ReconcileStore


def test_group_document_proposal_flow(tmp_path):
    path = tmp_path / "data.json"
    store = ReconcileStore(path=str(path))

    # create group and join members
    assert store.create_group("Alpha", "A group", ["civic", "open-source"], creator_id=1) is None
    assert store.join_group("Alpha", 2) is None
    assert store.join_group("Alpha", 3) is None

    # create a document and proposal
    doc_id = store.create_document("Alpha", "Charter", ["policy"], "We value kindness.")
    assert doc_id == 1
    pid = store.add_proposal("Alpha", doc_id, author_id=2, content="We value kindness and courage.")
    assert pid == 1

    # two accepts merge the proposal; further votes rejected
    assert store.record_vote("Alpha", doc_id, pid, user_id=1, vote="accept") is None
    assert store.record_vote("Alpha", doc_id, pid, user_id=2, vote="accept") is None
    assert (
        store.record_vote("Alpha", doc_id, pid, user_id=3, vote="reject")
        == "This proposal has already been merged."
    )

    doc = store.get_document("Alpha", doc_id)
    assert doc.content == "We value kindness and courage."
    assert doc.proposals[pid].merged is True

    # recommendations: create another group with overlapping tags
    assert store.create_group("Beta", "B group", ["open-source", "eco"], creator_id=4) is None
    recs = store.recommendations_for(user_id=1)
    assert "Beta" in recs


def test_record_vote_errors(tmp_path):
    store = ReconcileStore(path=str(tmp_path / "data.json"))
    store.create_group("Alpha", "A group", [], creator_id=1)
    doc_id = store.create_document("Alpha", "Doc", [], "text")
    pid = store.add_proposal("Alpha", doc_id, 1, "edit")

    # invalid vote string
    assert store.record_vote("Alpha", doc_id, pid, 1, "maybe") == "Invalid vote."

    # unknown document
    assert store.record_vote("Alpha", 99, pid, 1, "accept") == "Document not found."

    # unknown proposal
    assert store.record_vote("Alpha", doc_id, 99, 1, "accept") == "Proposal not found."

    # merge then attempt another vote
    store.record_vote("Alpha", doc_id, pid, 1, "accept")
    store.record_vote("Alpha", doc_id, pid, 2, "accept")
    assert (
        store.record_vote("Alpha", doc_id, pid, 3, "reject")
        == "This proposal has already been merged."
    )


def test_recommendations_empty(tmp_path):
    store = ReconcileStore(path=str(tmp_path / "data.json"))
    store.create_group("Alpha", "A group", [], creator_id=1)
    # user 1 already in Alpha but no tags => no recommendations
    assert store.recommendations_for(1) == []
    # user 2 not in any group => no recommendations
    assert store.recommendations_for(2) == []
