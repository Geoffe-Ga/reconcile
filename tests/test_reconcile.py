import types

from reconcile_bot.data.store import ReconcileStore


def test_reconcile_creation_and_vote(tmp_path):
    store = ReconcileStore(path=str(tmp_path / "data.json"))
    # create reconcile
    rid = store.create_reconcile(
        mode="group_vs_group", a_side="A", b_side="B", guild_id=1, channel_id=10, duration_hours=1
    )
    assert rid == 1
    rec = store.get_reconcile(rid)
    assert rec.a_side == "A"
    assert store.list_open_reconciles()[0].reconcile_id == rid

    # set message ids
    store.set_reconcile_message(rid, thread_id=100, message_id=200)
    rec = store.get_reconcile(rid)
    assert rec.thread_id == 100 and rec.message_id == 200

    # invalid score
    assert store.record_reconcile_vote(rid, voter_id=1, side="A", score=3) == "Score must be between -2 and +2."

    # valid vote and persistence
    assert store.record_reconcile_vote(rid, voter_id=1, side="A", score=2) is None
    store.save()
    # reload
    store2 = ReconcileStore(path=str(tmp_path / "data.json"))
    rec2 = store2.get_reconcile(rid)
    assert rec2.votes[1].score == 2

    # cancel and close
    assert store2.cancel_reconcile(rid) is True
    assert store2.list_open_reconciles() == []
    assert store2.close_reconcile(rid) is True
