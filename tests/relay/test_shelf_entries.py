"""A listed door's entries on the public shelf (#431, docs/spec/listed-doors.md §4.2).

An ``entry`` or a ``withdraw`` needs a live listing at its address (else 409
``not_listed``). An address keeps at most 4 live entries, and posts at most 1
new one each relay day (else 429 ``too_many_entries``); a withdrawn entry is
no longer live. A repeated entry, or a repeated withdraw, stores nothing new
and returns the first one's seq, and a withdraw names an entry the address
posted (else 409 ``no_entry``). An entry is kept 30 days after its first post.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from tests.relay.helpers import (
    DAY,
    NOON,
    FakeClock,
    ShelfSigner,
    entry,
    final_listing,
    listing,
    put_shelf,
    shelf_rows,
)

if TYPE_CHECKING:
    from pathlib import Path

    from starlette.testclient import TestClient

TODAY = int(NOON // DAY)


def _id(label: str) -> str:
    """A Dispatch id of 43 base64url characters from one letter."""
    return label * 43


def withdraw(entry_id: str) -> dict[str, Any]:
    """A withdraw's body, naming ``entry_id``."""
    return {"v": 1, "kind": "withdraw", "id": entry_id}


def _post(client: TestClient, door: ShelfSigner, body: dict[str, Any]) -> Any:
    """PUT ``body``, signed by ``door``, under its address."""
    return put_shelf(client, door.address, door.record(body))


def _listed(client: TestClient, door: ShelfSigner) -> None:
    """Post ``door``'s open listing."""
    assert _post(client, door, listing()).status_code == 201


def _answer(response: Any) -> tuple[int, Any]:
    """A response's status and JSON body."""
    return response.status_code, response.json()


NOT_LISTED = (409, {"error": "not_listed"})
TOO_MANY = (429, {"error": "too_many_entries"})


# --- not_listed ----------------------------------------------------------------


@pytest.mark.parametrize("body", [entry(_id("e")), withdraw(_id("e"))])
def test_an_entry_or_withdraw_needs_a_listing_at_its_address(
    shelf_client: TestClient, door: ShelfSigner, db_path: Path, body: dict[str, Any]
) -> None:
    """With no listing at the address, 409 not_listed, and nothing is stored."""
    other = ShelfSigner.fresh()
    _listed(shelf_client, other)

    assert _answer(_post(shelf_client, door, body)) == NOT_LISTED
    assert [row[1] for row in shelf_rows(db_path)] == [other.address]


def test_no_entry_follows_a_final_listing(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """A closed door's address takes no entry: its listing is final."""
    _listed(shelf_client, door)
    _post(shelf_client, door, final_listing())

    assert _answer(_post(shelf_client, door, entry(_id("e")))) == NOT_LISTED


def test_no_entry_follows_a_listing_that_lapsed(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """A listing 31 days past its last post is no longer live."""
    _listed(shelf_client, door)
    clock.advance(30 * DAY)
    assert _post(shelf_client, door, entry(_id("e"))).status_code == 201

    clock.advance(DAY)
    assert _answer(_post(shelf_client, door, entry(_id("f")))) == NOT_LISTED


# --- Repeats -------------------------------------------------------------------


def test_a_repeated_entry_stores_nothing_and_returns_the_first_seq(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock, db_path: Path
) -> None:
    """Every member's device may post it; the relay keeps one, whatever its text."""
    _listed(shelf_client, door)
    first = _post(shelf_client, door, entry(_id("e")))
    again = _post(shelf_client, door, entry(_id("e")))
    clock.advance(DAY)
    later = _post(shelf_client, door, entry(_id("e"), text="Another text."))

    assert _answer(first) == (201, {"seq": 2})
    assert _answer(again) == (200, {"seq": 2})
    assert _answer(later) == (200, {"seq": 2})
    assert [row[2:4] for row in shelf_rows(db_path)] == [
        ("listing", ""),
        ("entry", _id("e")),
    ]


def test_a_repeat_is_by_address_and_id(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """Another door's entry under the same id is its own."""
    other = ShelfSigner.fresh()
    _listed(shelf_client, door)
    _listed(shelf_client, other)
    _post(shelf_client, door, entry(_id("e")))

    assert _answer(_post(shelf_client, other, entry(_id("e")))) == (201, {"seq": 4})


def test_a_withdrawn_entry_never_comes_back(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """Posting a withdrawn id again returns its first seq and stores nothing."""
    _listed(shelf_client, door)
    _post(shelf_client, door, entry(_id("e")))
    _post(shelf_client, door, withdraw(_id("e")))
    clock.advance(DAY)

    assert _answer(_post(shelf_client, door, entry(_id("e")))) == (200, {"seq": 2})


def test_an_expired_entry_can_be_posted_again(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """Past its 30 days an entry is gone, so its id is new again."""
    _listed(shelf_client, door)
    _post(shelf_client, door, entry(_id("e")))
    clock.advance(20 * DAY)
    _listed(shelf_client, door)
    clock.advance(11 * DAY)

    assert _answer(_post(shelf_client, door, entry(_id("e")))) == (201, {"seq": 3})


# --- Caps ----------------------------------------------------------------------


def test_one_new_entry_per_relay_day(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """A second new entry the same UTC day gets 429; the next day takes it."""
    _listed(shelf_client, door)
    assert _post(shelf_client, door, entry(_id("e"))).status_code == 201

    assert _answer(_post(shelf_client, door, entry(_id("f")))) == TOO_MANY
    clock.advance(DAY // 2 - 1)  # 23:59:59 the same day
    assert _answer(_post(shelf_client, door, entry(_id("f")))) == TOO_MANY
    clock.advance(1)  # midnight
    assert _post(shelf_client, door, entry(_id("f"))).status_code == 201


def test_a_day_is_counted_per_address(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """Another door's entry today doesn't use this door's."""
    other = ShelfSigner.fresh()
    _listed(shelf_client, door)
    _listed(shelf_client, other)
    _post(shelf_client, other, entry(_id("e")))

    assert _post(shelf_client, door, entry(_id("f"))).status_code == 201


def test_a_withdrawn_entry_still_used_its_day(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """Withdrawing today's entry doesn't free today for another."""
    _listed(shelf_client, door)
    _post(shelf_client, door, entry(_id("e")))
    _post(shelf_client, door, withdraw(_id("e")))

    assert _answer(_post(shelf_client, door, entry(_id("f")))) == TOO_MANY


def _four_days_of_entries(
    client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """A listing, then one entry each day for 4 days, ending a day after the last."""
    _listed(client, door)
    for label in "abcd":
        assert _post(client, door, entry(_id(label))).status_code == 201
        clock.advance(DAY)


def test_at_most_four_live_entries(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """A fifth live entry gets 429, though it is a new day."""
    _four_days_of_entries(shelf_client, door, clock)

    assert _answer(_post(shelf_client, door, entry(_id("e")))) == TOO_MANY


def test_a_withdrawn_entry_frees_its_place(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """A withdrawn entry is no longer live, so another takes its place."""
    _four_days_of_entries(shelf_client, door, clock)
    _post(shelf_client, door, withdraw(_id("b")))

    assert _post(shelf_client, door, entry(_id("e"))).status_code == 201


def test_an_expired_entry_frees_its_place(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """The first entry's 30 days end, and a fifth is live in its place."""
    _four_days_of_entries(shelf_client, door, clock)
    clock.advance(26 * DAY)  # day 30 after the first entry's day: still live
    _listed(shelf_client, door)
    assert _answer(_post(shelf_client, door, entry(_id("e")))) == TOO_MANY

    clock.advance(DAY)

    assert _post(shelf_client, door, entry(_id("e"))).status_code == 201


# --- Withdrawals ---------------------------------------------------------------


def test_a_withdraw_names_an_entry_its_address_posted(
    shelf_client: TestClient, door: ShelfSigner, db_path: Path
) -> None:
    """A withdraw naming no entry at its address gets 409 no_entry."""
    other = ShelfSigner.fresh()
    _listed(shelf_client, door)
    _listed(shelf_client, other)
    _post(shelf_client, other, entry(_id("e")))

    response = _post(shelf_client, door, withdraw(_id("e")))

    assert _answer(response) == (409, {"error": "no_entry"})
    assert [row[2] for row in shelf_rows(db_path)] == ["listing", "listing", "entry"]


def test_a_repeated_withdraw_stores_nothing_and_returns_the_first_seq(
    shelf_client: TestClient, door: ShelfSigner, db_path: Path
) -> None:
    """Every member's device may withdraw a stray; the relay keeps one."""
    _listed(shelf_client, door)
    _post(shelf_client, door, entry(_id("e")))

    first = _post(shelf_client, door, withdraw(_id("e")))
    again = _post(shelf_client, door, withdraw(_id("e")))

    assert _answer(first) == (201, {"seq": 3})
    assert _answer(again) == (200, {"seq": 3})
    assert [row[2] for row in shelf_rows(db_path)] == ["listing", "entry", "withdraw"]


def test_an_entry_is_kept_thirty_days_after_its_first_post(
    shelf_client: TestClient, door: ShelfSigner, db_path: Path
) -> None:
    """Its expiry is 31 days after the day it arrived, as for every shelf record."""
    _listed(shelf_client, door)
    _post(shelf_client, door, entry(_id("e")))

    assert shelf_rows(db_path)[1][6] == TODAY + 31
