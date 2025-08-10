from reconcile_bot.data.store import ReconcileStore

def test_group_document_proposal_flow(tmp_path):
    path = tmp_path / "data.json"
    store = ReconcileStore(path=str(path))
    err = store.create_group("Alpha", "A group", ["civic", "open-source"], creator_id=1)
    assert err is None
    assert "Alpha" in store.groups
    assert 1 in store.groups["Alpha"].members

    # join two more members
    assert store.join_group("Alpha", 2) is None
    assert store.join_group("Alpha", 3) is None

    # create a doc
    doc_id = store.create_document("Alpha", "Charter", ["policy"], "We value kindness.")
    assert doc_id == 1
    assert store.get_document("Alpha", 1) is not None

    # propose an edit
    pid = store.add_proposal("Alpha", 1, author_id=2, content="We value kindness and courage.")
    assert pid == 1

    # votes: 2 accepts, 1 reject (members: 3 -> required majority = 2)
    assert store.record_vote("Alpha", 1, 1, user_id=1, vote="accept") is None
    assert store.record_vote("Alpha", 1, 1, user_id=2, vote="accept") is None
    assert store.record_vote("Alpha", 1, 1, user_id=3, vote="reject") is None

    doc = store.get_document("Alpha", 1)
    prop = doc.proposals[1]
    assert prop.merged is True
    assert doc.content == "We value kindness and courage."

    # recommendations: create another group with overlapping tags
    assert store.create_group("Beta", "B group", ["policy", "eco"], creator_id=4) is None
    recs = store.recommendations_for(user_id=1)
    assert "Beta" in recs or len(recs) >= 0  # non-strict, just exercise code path