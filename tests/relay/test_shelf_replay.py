"""No one can replay a steward's notice (#490's review, listed-doors.md §4.1, §6.1).

The relay serves every live notice to anyone, so whoever saved one could PUT
its bytes again later: an old ``unsuspend`` after a fresh suspend, an old
``suspend`` after a lift, an old ``hold``, or an old ``release`` of a
relisting a lift sent back for a fresh one. Every notice therefore carries
``day``, the UTC day the steward signed it, and ``n``, a fresh 16-byte
nonce, both signed with the rest. The relay refuses a notice whose day isn't
today or yesterday (400 ``stale_notice``), and one whose nonce it has taken
before (409 ``replayed_notice``), keeping each nonce until its notice could
no longer be taken, however soon the notice itself is deleted.
"""

from __future__ import annotations

import base64
import sqlite3
from contextlib import closing
from typing import TYPE_CHECKING, Any

import pytest

from reconcile.relay.purge import purge
from tests.relay.helpers import (
    DAY,
    NOON,
    FakeClock,
    ShelfSigner,
    entry,
    listing,
    nonce,
    notice,
    put_notice,
    put_shelf,
    shelf_rows,
    stamped,
    store_of,
)

if TYPE_CHECKING:
    from pathlib import Path

    from starlette.testclient import TestClient

TODAY = int(NOON // DAY)


def _signed(steward: ShelfSigner, body: dict[str, Any], day: int = TODAY) -> bytes:
    """``body`` stamped with ``day`` and a fresh nonce, signed by the steward."""
    return steward.record(stamped(body, day=day))


def _put(client: TestClient, steward: ShelfSigner, record: bytes) -> Any:
    """PUT the steward's signed ``record`` under its address."""
    return put_shelf(client, steward.address, record)


def _list(client: TestClient, door: ShelfSigner) -> Any:
    """PUT ``door``'s listing under its address."""
    return put_shelf(client, door.address, door.record(listing()))


def _addresses(client: TestClient, path: str = "/v1/shelf") -> list[str]:
    """The address of each record a GET of ``path`` serves."""
    return [record["address"] for record in client.get(path).json()["records"]]


def _refused(response: Any, status: int, code: str) -> None:
    """``response`` is the constant refusal ``code`` with ``status``."""
    assert response.status_code == status
    assert response.json() == {"error": code}


# --- Replays -----------------------------------------------------------------


def test_an_old_unsuspend_replayed_after_a_new_suspend_is_refused(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """The reviewer's case: the address stays suspended."""
    _list(shelf_client, door)
    put_notice(
        shelf_client, steward, notice("suspend", address=door.address, clause="C3")
    )
    lift = _signed(steward, notice("unsuspend", address=door.address))
    assert _put(shelf_client, steward, lift).status_code == 201
    again = notice("suspend", address=door.address, clause="C3")
    assert put_notice(shelf_client, steward, again).status_code == 201
    rows = len(shelf_client.get("/v1/shelf").json()["records"])

    _refused(_put(shelf_client, steward, lift), 409, "replayed_notice")

    _refused(_list(shelf_client, door), 403, "suspended")
    assert len(shelf_client.get("/v1/shelf").json()["records"]) == rows


def test_an_old_suspend_replayed_after_a_lift_is_refused(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """The lift stands: the door lists again, and nothing of it is deleted."""
    _list(shelf_client, door)
    suspend = _signed(steward, notice("suspend", address=door.address, clause="C3"))
    assert _put(shelf_client, steward, suspend).status_code == 201
    put_notice(shelf_client, steward, notice("unsuspend", address=door.address))
    assert _list(shelf_client, door).status_code == 201

    _refused(_put(shelf_client, steward, suspend), 409, "replayed_notice")

    assert _addresses(shelf_client, "/v1/shelf/held") == [door.address]
    assert _list(shelf_client, door).status_code == 201


def test_an_old_hold_replayed_is_refused(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """A hold taken once holds once: its bytes again hold nothing."""
    _list(shelf_client, door)
    put_notice(shelf_client, steward, notice("release", address=door.address))
    hold = _signed(steward, notice("hold", address=door.address, clause="C2"))
    assert _put(shelf_client, steward, hold).status_code == 201

    _refused(_put(shelf_client, steward, hold), 409, "replayed_notice")


def test_an_old_release_replayed_after_a_lift_is_refused(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """The relisting a lift sent back waits for a fresh release, not an old one."""
    _list(shelf_client, door)
    release = _signed(steward, notice("release", address=door.address))
    assert _put(shelf_client, steward, release).status_code == 201
    put_notice(
        shelf_client, steward, notice("suspend", address=door.address, clause="C1")
    )
    put_notice(shelf_client, steward, notice("unsuspend", address=door.address))
    _list(shelf_client, door)

    _refused(_put(shelf_client, steward, release), 409, "replayed_notice")

    assert door.address not in _addresses(shelf_client)
    assert _addresses(shelf_client, "/v1/shelf/held") == [door.address]


def test_a_second_suspend_under_the_same_clause_with_a_new_nonce_stands(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """Bytes alone can't tell a replay from a fresh decision; the nonce can."""
    _list(shelf_client, door)
    suspend = notice("suspend", address=door.address, clause="C3")
    assert put_notice(shelf_client, steward, suspend).status_code == 201
    put_notice(shelf_client, steward, notice("unsuspend", address=door.address))

    assert put_notice(shelf_client, steward, suspend).status_code == 201

    _refused(_list(shelf_client, door), 403, "suspended")


def test_a_replay_is_refused_before_it_is_read_for_anything_else(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """A replayed unsuspend says ``replayed_notice``, not ``not_suspended``."""
    _list(shelf_client, door)
    put_notice(
        shelf_client, steward, notice("suspend", address=door.address, clause="C3")
    )
    lift = _signed(steward, notice("unsuspend", address=door.address))
    _put(shelf_client, steward, lift)

    _refused(_put(shelf_client, steward, lift), 409, "replayed_notice")


def test_the_same_nonce_under_another_act_is_refused(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """A nonce is the steward's once, whatever it was signed beside."""
    used = nonce()
    put_notice(shelf_client, steward, notice("pause", on=True), n=used)

    response = put_notice(shelf_client, steward, notice("pause", on=False), n=used)

    _refused(response, 409, "replayed_notice")


# --- The day ---------------------------------------------------------------


@pytest.mark.parametrize(("offset", "status"), [(0, 201), (-1, 201)])
def test_a_notice_signed_today_or_yesterday_is_taken(
    shelf_client: TestClient, steward: ShelfSigner, offset: int, status: int
) -> None:
    """A steward near midnight, or a slow upload, still lands."""
    body = notice("pause", on=True)

    assert (
        put_notice(shelf_client, steward, body, day=TODAY + offset).status_code
        == status
    )


@pytest.mark.parametrize("offset", [-2, -180, 1, 2])
def test_a_notice_signed_on_any_other_day_is_stale(
    shelf_client: TestClient, db_path: Path, steward: ShelfSigner, offset: int
) -> None:
    """Two days old, or tomorrow's, gets 400 stale_notice, and nothing is stored."""
    response = put_notice(
        shelf_client, steward, notice("pause", on=True), day=TODAY + offset
    )

    _refused(response, 400, "stale_notice")
    assert shelf_rows(db_path) == []


def test_a_notice_kept_two_days_is_refused_whatever_its_nonce(
    shelf_client: TestClient, steward: ShelfSigner, clock: FakeClock
) -> None:
    """An unused, saved notice is useless once its day has passed."""
    saved = _signed(steward, notice("pause", on=True))
    clock.advance(2 * DAY)

    _refused(_put(shelf_client, steward, saved), 400, "stale_notice")


@pytest.mark.parametrize(
    "stamp",
    [
        {},
        {"day": TODAY},
        {"n": "A" * 22},
        {"day": TODAY, "n": "A" * 21},
        {"day": TODAY, "n": "A" * 43},
        {"day": TODAY, "n": "AAAAAAAAAAAAAAAAAAAAAB"},  # a spare bit set
        {"day": TODAY, "n": "AAAAAAAAAAAAAAAAAAAA+/"},
        {"day": TODAY, "n": 7},
        {"day": str(TODAY), "n": "A" * 22},
        {"day": True, "n": "A" * 22},
        {"day": float(TODAY), "n": "A" * 22},
        {"day": -1, "n": "A" * 22},
    ],
)
def test_a_notice_without_a_day_and_a_nonce_is_no_record(
    shelf_client: TestClient, db_path: Path, steward: ShelfSigner, stamp: dict[str, Any]
) -> None:
    """``day`` is a whole day number and ``n`` 16 bytes in canonical base64url."""
    body = {**notice("pause", on=True), **stamp}

    _refused(_put(shelf_client, steward, steward.record(body)), 400, "invalid_record")
    assert shelf_rows(db_path) == []


# --- How long a nonce is remembered -----------------------------------------


def test_a_nonce_outlives_an_uphold_purged_the_next_day(
    shelf_client: TestClient,
    db_path: Path,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """An uphold is kept only as long as its entry, yet its nonce stays.

    The entry came 30 days ago, so the uphold expires tomorrow and the purge
    deletes it then, while the notice's own day still lets it in. The door
    posts the entry again; the uphold's bytes, PUT again, don't take it down.
    """
    entry_id = base64.urlsafe_b64encode(bytes(32)).rstrip(b"=").decode("ascii")
    _list(shelf_client, door)
    put_notice(shelf_client, steward, notice("release", address=door.address))
    put_shelf(shelf_client, door.address, door.record(entry(entry_id)))
    clock.advance(30 * DAY)
    _list(shelf_client, door)
    body = notice("uphold", address=door.address, id=entry_id, clause="C2")
    uphold = _signed(steward, body, day=TODAY + 30)
    assert _put(shelf_client, steward, uphold).status_code == 201
    clock.advance(DAY)
    purge(store_of(shelf_client.app), clock())
    assert [row for row in shelf_rows(db_path) if row[3].startswith("uphold:")] == []
    posted = put_shelf(shelf_client, door.address, door.record(entry(entry_id)))
    assert posted.status_code == 201

    _refused(_put(shelf_client, steward, uphold), 409, "replayed_notice")

    assert entry_id_shown(shelf_client, door, entry_id)


def test_a_nonce_outlives_its_notice_row_however_it_goes(
    shelf_client: TestClient, db_path: Path, steward: ShelfSigner
) -> None:
    """The nonce is kept apart from the row, so no deletion of the row frees it."""
    pause = _signed(steward, notice("pause", on=True))
    assert _put(shelf_client, steward, pause).status_code == 201
    with closing(sqlite3.connect(db_path)) as db:
        db.execute("DELETE FROM shelf")
        db.commit()

    _refused(_put(shelf_client, steward, pause), 409, "replayed_notice")


def test_a_nonce_is_forgotten_once_its_notice_could_be_taken_no_more(
    shelf_client: TestClient, db_path: Path, steward: ShelfSigner, clock: FakeClock
) -> None:
    """Kept while the notice's day is today or yesterday, purged after."""
    put_notice(shelf_client, steward, notice("pause", on=True))
    assert nonce_rows(db_path) == 1
    clock.advance(DAY)
    purge(store_of(shelf_client.app), clock())
    assert nonce_rows(db_path) == 1

    clock.advance(DAY)
    purge(store_of(shelf_client.app), clock())

    assert nonce_rows(db_path) == 0


def test_a_refused_notice_spends_no_nonce(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """An unsuspend with nothing to lift stores neither its row nor its nonce."""
    used = nonce()
    lift = notice("unsuspend", address=door.address)

    _refused(put_notice(shelf_client, steward, lift, n=used), 409, "not_suspended")

    assert nonce_rows(db_path) == 0


def entry_id_shown(client: TestClient, door: ShelfSigner, entry_id: str) -> bool:
    """Whether the shelf serves a record under ``door`` that names ``entry_id``."""
    records = client.get("/v1/shelf").json()["records"]
    return any(
        record["address"] == door.address
        and entry_id in base64.b64decode(record["data"]).decode("utf-8", "replace")
        for record in records
    )


def nonce_rows(db_path: Path) -> int:
    """How many nonces the relay remembers."""
    with closing(sqlite3.connect(db_path)) as db:
        (count,) = db.execute("SELECT count(*) FROM notice_nonces").fetchone()
    return int(count)
