"""The steward's hold, uphold, suspend and pause (#489, listed-doors.md §6.1).

A ``hold`` hides an address's records, or one entry, for 10,080 relay
minutes, and then they show again unless an ``uphold`` came. An ``uphold``
deletes the entry it names and keeps the notice exactly as long as the entry
would have been kept, refusing the entry again meanwhile (403 ``upheld``). A
``suspend`` deletes an address's records and refuses its PUTs (403
``suspended``) while the notice stands. A ``pause`` is stored and does
nothing else on the relay: devices fold it. Every notice is PUT under the
steward's address and signed by its key, as a release is (#488).
"""

from __future__ import annotations

import base64
import os
from typing import TYPE_CHECKING, Any

import pytest

from reconcile.relay.purge import purge
from reconcile.relay.store import HELD_UNTIL_RELEASED
from tests.relay.helpers import (
    DAY,
    MINUTE,
    NOON,
    FakeClock,
    ShelfSigner,
    entry,
    listing,
    put_shelf,
    shelf_rows,
    store_of,
)

if TYPE_CHECKING:
    from pathlib import Path

    from starlette.testclient import TestClient

TODAY = int(NOON // DAY)
NOW_MINUTE = int(NOON // MINUTE)
HOLD = 10_080  # relay minutes


def _key() -> str:
    """A fresh canonical 32-byte value in unpadded base64url: an entry id."""
    return base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode("ascii")


def notice(act: str, **fields: Any) -> dict[str, Any]:
    """A notice's body: ``act`` and whatever it names."""
    return {"v": 1, "kind": "notice", "act": act, **fields}


def _steward(client: TestClient, steward: ShelfSigner, body: dict[str, Any]) -> Any:
    """PUT ``body`` as the steward's notice."""
    return put_shelf(client, steward.address, steward.record(body))


def _post(client: TestClient, door: ShelfSigner, body: dict[str, Any]) -> Any:
    """PUT ``body``, signed by ``door``, under its address."""
    return put_shelf(client, door.address, door.record(body))


def _live(client: TestClient, door: ShelfSigner, steward: ShelfSigner) -> None:
    """``door``'s listing, released by the steward."""
    assert _post(client, door, listing()).status_code == 201
    release = notice("release", address=door.address)
    assert _steward(client, steward, release).status_code == 201


def _shown(client: TestClient) -> list[tuple[str, int]]:
    """The (address, seq) of each record ``GET /v1/shelf`` serves."""
    records = client.get("/v1/shelf").json()["records"]
    return [(record["address"], record["seq"]) for record in records]


def _addresses(client: TestClient, path: str = "/v1/shelf") -> list[str]:
    """The address of each record a GET of ``path`` serves."""
    return [record["address"] for record in client.get(path).json()["records"]]


# --- hold ---------------------------------------------------------------------


def test_a_hold_hides_an_address_for_10080_minutes_then_it_shows_again(
    shelf_client: TestClient,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """Hidden at 10,079 minutes, shown at 10,080, with no uphold."""
    _live(shelf_client, door, steward)
    assert _post(shelf_client, door, entry(_key())).status_code == 201
    hold = notice("hold", address=door.address, clause="C2")

    assert _steward(shelf_client, steward, hold).status_code == 201

    assert _addresses(shelf_client) == [steward.address] * 2
    assert _addresses(shelf_client, "/v1/shelf/held") == [door.address] * 2
    clock.advance((HOLD - 1) * MINUTE)
    assert door.address not in _addresses(shelf_client)
    clock.advance(MINUTE)
    assert _addresses(shelf_client).count(door.address) == 2
    assert _addresses(shelf_client, "/v1/shelf/held") == []


def test_a_hold_sets_each_record_held_until_its_minute(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """The listing and entry wait until 10,080 minutes after the notice arrived."""
    _live(shelf_client, door, steward)
    _post(shelf_client, door, entry(_key()))

    _steward(shelf_client, steward, notice("hold", address=door.address, clause="C3"))

    rows = shelf_rows(db_path)
    held = [row[-1] for row in rows if row[1] == door.address]
    assert held == [NOW_MINUTE + HOLD] * 2
    assert rows[-1][2:4] == ("notice", f"hold:{door.address}")
    assert rows[-1][5:] == (NOW_MINUTE, TODAY + 181, 0)


def test_a_record_posted_under_a_held_address_waits_with_it(
    shelf_client: TestClient,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """An entry posted during a hold shows when the hold lapses, not before."""
    _live(shelf_client, door, steward)
    _steward(shelf_client, steward, notice("hold", address=door.address, clause="C2"))
    clock.advance(DAY)

    assert _post(shelf_client, door, entry(_key())).status_code == 201

    assert door.address not in _addresses(shelf_client)
    clock.advance((HOLD - 1440) * MINUTE)
    assert _addresses(shelf_client).count(door.address) == 2


def test_a_hold_of_an_entry_hides_only_that_entry(
    shelf_client: TestClient,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """The listing and the address's other entry stay live."""
    _live(shelf_client, door, steward)
    held, kept = _key(), _key()
    first = _post(shelf_client, door, entry(held)).json()["seq"]
    clock.advance(DAY)
    second = _post(shelf_client, door, entry(kept)).json()["seq"]

    hold = notice("hold", address=door.address, id=held, clause="C2")
    _steward(shelf_client, steward, hold)

    shown = [seq for address, seq in _shown(shelf_client) if address == door.address]
    assert first not in shown
    assert second in shown
    assert len(shown) == 2


def test_a_release_after_a_hold_keeps_the_hold(
    shelf_client: TestClient,
    db_path: Path,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """A hold on a listing still waiting for release outlasts the release."""
    _post(shelf_client, door, listing())
    _steward(shelf_client, steward, notice("hold", address=door.address, clause="C3"))
    clock.advance(10 * MINUTE)

    _steward(shelf_client, steward, notice("release", address=door.address))

    assert shelf_rows(db_path)[0][-1] == NOW_MINUTE + HOLD
    assert door.address not in _addresses(shelf_client)
    clock.advance((HOLD - 10) * MINUTE)
    assert door.address in _addresses(shelf_client)


def test_a_release_with_no_hold_standing_clears_to_zero(
    shelf_client: TestClient,
    db_path: Path,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """A hold that lapsed before the release leaves nothing held."""
    _post(shelf_client, door, listing())
    _steward(shelf_client, steward, notice("hold", address=door.address, clause="C3"))
    clock.advance(HOLD * MINUTE)

    _steward(shelf_client, steward, notice("release", address=door.address))

    assert shelf_rows(db_path)[0][-1] == 0


def test_a_hold_never_shortens_the_wait_for_a_release(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """A held first listing stays held until released, whatever the hold."""
    _post(shelf_client, door, listing())

    _steward(shelf_client, steward, notice("hold", address=door.address, clause="C3"))

    assert shelf_rows(db_path)[0][-1] == HELD_UNTIL_RELEASED


# --- uphold -------------------------------------------------------------------


def test_an_uphold_deletes_the_entry_and_keeps_the_notice_as_long_as_it(
    shelf_client: TestClient,
    db_path: Path,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """The entry's rows go; the notice expires on the day the entry would have."""
    _live(shelf_client, door, steward)
    upheld = _key()
    _post(shelf_client, door, entry(upheld))
    _post(shelf_client, door, {"v": 1, "kind": "withdraw", "id": upheld})
    clock.advance(3 * DAY)
    _steward(
        shelf_client,
        steward,
        notice("hold", address=door.address, id=upheld, clause="C2"),
    )

    response = _steward(
        shelf_client,
        steward,
        notice("uphold", address=door.address, id=upheld, clause="C2"),
    )

    assert response.status_code == 201
    rows = shelf_rows(db_path)
    assert [row[2] for row in rows if row[1] == door.address] == ["listing"]
    assert rows[-1][2:4] == ("notice", f"uphold:{door.address}:{upheld}")
    assert rows[-1][5:] == (NOW_MINUTE + 3 * 1440, TODAY + 31, 0)


def test_an_upheld_entry_is_refused_while_its_notice_stands(
    shelf_client: TestClient,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """A member's device that posts it again gets 403 upheld meanwhile."""
    _live(shelf_client, door, steward)
    upheld = _key()
    _post(shelf_client, door, entry(upheld))
    _steward(
        shelf_client,
        steward,
        notice("uphold", address=door.address, id=upheld, clause="C2"),
    )
    clock.advance(DAY)

    response = _post(shelf_client, door, entry(upheld))

    assert response.status_code == 403
    assert response.json() == {"error": "upheld"}
    assert _post(shelf_client, door, entry(_key())).status_code == 201


def test_an_uphold_needs_a_live_entry(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """An uphold of no entry at the address gets 409 no_entry and stores nothing."""
    _live(shelf_client, door, steward)
    before = shelf_rows(db_path)

    body = notice("uphold", address=door.address, id=_key(), clause="C1")
    response = _steward(shelf_client, steward, body)

    assert response.status_code == 409
    assert response.json() == {"error": "no_entry"}
    assert shelf_rows(db_path) == before


# --- suspend ------------------------------------------------------------------


def test_a_suspend_deletes_the_address_records_and_refuses_its_puts(
    shelf_client: TestClient,
    db_path: Path,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """Its listing and entries go, and every later PUT under it gets 403 suspended."""
    _live(shelf_client, door, steward)
    _post(shelf_client, door, entry(_key()))

    body = notice("suspend", address=door.address, clause="C3")
    assert _steward(shelf_client, steward, body).status_code == 201

    rows = shelf_rows(db_path)
    assert door.address not in [row[1] for row in rows]
    assert rows[-1][2:4] == ("notice", f"suspend:{door.address}")
    clock.advance(179 * DAY)
    for record in (listing(), entry(_key())):
        response = _post(shelf_client, door, record)
        assert response.status_code == 403
        assert response.json() == {"error": "suspended"}
    assert door.address not in [row[1] for row in shelf_rows(db_path)]


def test_a_suspension_ends_with_its_notice(
    shelf_client: TestClient,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """After 180 days the notice is purged and the address is a new one, held."""
    _steward(
        shelf_client, steward, notice("suspend", address=door.address, clause="C2")
    )
    clock.advance(181 * DAY)
    purge(store_of(shelf_client.app), clock())

    assert _post(shelf_client, door, listing()).status_code == 201
    assert _addresses(shelf_client, "/v1/shelf/held") == [door.address]


def test_a_suspend_leaves_other_addresses_alone(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """Another door's listing stays, and it may still post."""
    other = ShelfSigner.fresh()
    _live(shelf_client, door, steward)
    _live(shelf_client, other, steward)

    _steward(
        shelf_client, steward, notice("suspend", address=door.address, clause="C3")
    )

    assert other.address in _addresses(shelf_client)
    assert _post(shelf_client, other, entry(_key())).status_code == 201


# --- pause --------------------------------------------------------------------


@pytest.mark.parametrize("on", [True, False])
def test_a_pause_is_stored_and_changes_nothing_else(
    shelf_client: TestClient,
    db_path: Path,
    door: ShelfSigner,
    steward: ShelfSigner,
    on: bool,
) -> None:
    """On or off, the relay keeps the notice 180 days and serves all as before."""
    _live(shelf_client, door, steward)
    before = shelf_rows(db_path)

    assert _steward(shelf_client, steward, notice("pause", on=on)).status_code == 201

    rows = shelf_rows(db_path)
    assert rows[:-1] == before
    assert rows[-1][2:4] == ("notice", "pause")
    assert rows[-1][6:] == (TODAY + 181, 0)
    assert _addresses(shelf_client) == [door.address, steward.address, steward.address]


# --- what the relay takes ----------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        notice("hold", address="A" * 43),
        notice("hold", address="A" * 43, clause="C4"),
        notice("hold", address="A" * 43, id="not-an-id", clause="C1"),
        notice("hold", clause="C1"),
        notice("uphold", address="A" * 43, clause="C1"),
        notice("uphold", address="A" * 43, id="A" * 43),
        notice("suspend", address="A" * 43),
        notice("suspend", address="not-a-key", clause="C1"),
        notice("pause"),
        notice("pause", on="yes"),
        notice("pause", on=1),
        notice("resume"),
    ],
)
def test_a_notice_missing_what_its_act_names_is_no_record(
    shelf_client: TestClient, db_path: Path, steward: ShelfSigner, body: dict[str, Any]
) -> None:
    """A hold, uphold or suspend names a clause; a pause, on or off."""
    response = _steward(shelf_client, steward, body)

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_record"}
    assert shelf_rows(db_path) == []


@pytest.mark.parametrize(
    "body",
    [
        notice("hold", address="A" * 43, clause="C2"),
        notice("suspend", address="A" * 43, clause="C3"),
        notice("pause", on=True),
    ],
)
def test_a_door_cannot_sign_a_notice(
    shelf_client: TestClient, door: ShelfSigner, body: dict[str, Any]
) -> None:
    """Under a door's own address, every act gets 403 bad_signature."""
    response = _post(shelf_client, door, body)

    assert response.status_code == 403
    assert response.json() == {"error": "bad_signature"}
