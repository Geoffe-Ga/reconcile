"""The steward lifts a suspension (#490's follow-up, listed-doors.md §6.1).

An ``unsuspend`` notice names an address whose suspension stands, and ends
it: PUTs under that address are taken again, and the address lists as a
new one, its first listing held until a fresh ``release``, as any first
listing in held mode is. The suspend notice stays: the newer of the two
decides, by seq, so a suspend after the lift stands again. An unsuspend
with no suspension standing gets 409 ``not_suspended`` and stores nothing.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from reconcile.relay.purge import purge
from tests.relay.helpers import (
    DAY,
    NOON,
    FakeClock,
    ShelfSigner,
    listing,
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


def _steward(client: TestClient, steward: ShelfSigner, body: dict[str, Any]) -> Any:
    """PUT ``body`` as the steward's notice, stamped with the relay's day."""
    return put_notice(client, steward, body)


def _list(client: TestClient, door: ShelfSigner) -> Any:
    """PUT ``door``'s listing under its address."""
    return put_shelf(client, door.address, door.record(listing()))


def _addresses(client: TestClient, path: str = "/v1/shelf") -> list[str]:
    """The address of each record a GET of ``path`` serves."""
    return [record["address"] for record in client.get(path).json()["records"]]


def _suspended(client: TestClient, door: ShelfSigner, steward: ShelfSigner) -> None:
    """``door`` listed, released, then suspended under C3."""
    assert _list(client, door).status_code == 201
    release = notice("release", address=door.address)
    assert _steward(client, steward, release).status_code == 201
    suspend = notice("suspend", address=door.address, clause="C3")
    assert _steward(client, steward, suspend).status_code == 201


def test_an_unsuspend_takes_the_address_puts_again(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """After the lift, the door's listing is stored rather than 403 suspended."""
    _suspended(shelf_client, door, steward)
    assert _list(shelf_client, door).status_code == 403

    lift = notice("unsuspend", address=door.address)
    assert _steward(shelf_client, steward, lift).status_code == 201

    assert _list(shelf_client, door).status_code == 201


def test_a_lifted_address_lists_held_until_a_fresh_release(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """The release before the suspend releases nothing now; a new one does."""
    _suspended(shelf_client, door, steward)
    _steward(shelf_client, steward, notice("unsuspend", address=door.address))

    _list(shelf_client, door)

    assert door.address not in _addresses(shelf_client)
    assert _addresses(shelf_client, "/v1/shelf/held") == [door.address]
    _steward(shelf_client, steward, notice("release", address=door.address))
    assert door.address in _addresses(shelf_client)
    assert _addresses(shelf_client, "/v1/shelf/held") == []


def test_an_unsuspend_is_kept_beside_the_suspend_it_lifts(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """Both notices stay, each 180 days, filed under what they act on."""
    _suspended(shelf_client, door, steward)

    _steward(shelf_client, steward, notice("unsuspend", address=door.address))

    refs = [(row[2], row[3], row[6]) for row in shelf_rows(db_path)]
    assert refs[-2:] == [
        ("notice", f"suspend:{door.address}", TODAY + 181),
        ("notice", f"unsuspend:{door.address}", TODAY + 181),
    ]


def test_a_suspend_after_the_lift_stands_again_in_the_same_minute(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """The newer notice decides by seq, not by its receipt minute."""
    _suspended(shelf_client, door, steward)
    _steward(shelf_client, steward, notice("unsuspend", address=door.address))

    again = notice("suspend", address=door.address, clause="C1")
    assert _steward(shelf_client, steward, again).status_code == 201

    response = _list(shelf_client, door)
    assert response.status_code == 403
    assert response.json() == {"error": "suspended"}


def test_a_listing_posted_after_the_lift_is_deleted_by_a_new_suspend(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """A second suspend deletes what came under the address since the lift."""
    _suspended(shelf_client, door, steward)
    _steward(shelf_client, steward, notice("unsuspend", address=door.address))
    _list(shelf_client, door)

    _steward(
        shelf_client, steward, notice("suspend", address=door.address, clause="C2")
    )

    assert door.address not in [row[1] for row in shelf_rows(db_path)]


@pytest.mark.parametrize("lifted", [False, True])
def test_an_unsuspend_needs_a_suspension_standing(
    shelf_client: TestClient,
    db_path: Path,
    door: ShelfSigner,
    steward: ShelfSigner,
    lifted: bool,
) -> None:
    """None ever, or one already lifted: 409 not_suspended, nothing stored."""
    if lifted:
        _suspended(shelf_client, door, steward)
        _steward(shelf_client, steward, notice("unsuspend", address=door.address))
    before = shelf_rows(db_path)

    response = _steward(
        shelf_client, steward, notice("unsuspend", address=door.address)
    )

    assert response.status_code == 409
    assert response.json() == {"error": "not_suspended"}
    assert shelf_rows(db_path) == before


def test_an_unsuspend_after_the_suspend_expired_is_refused(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner, clock: FakeClock
) -> None:
    """A suspension that lapsed at 180 days has nothing left to lift."""
    _suspended(shelf_client, door, steward)
    clock.advance(181 * DAY)
    purge(store_of(shelf_client.app), clock())

    response = _steward(
        shelf_client, steward, notice("unsuspend", address=door.address)
    )

    assert response.status_code == 409
    assert response.json() == {"error": "not_suspended"}


@pytest.mark.parametrize(
    "body",
    [
        notice("unsuspend"),
        notice("unsuspend", address="not-a-key"),
    ],
)
def test_an_unsuspend_names_an_address(
    shelf_client: TestClient, db_path: Path, steward: ShelfSigner, body: dict[str, Any]
) -> None:
    """Without a key-shaped address it is no record."""
    response = _steward(shelf_client, steward, body)

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_record"}
    assert shelf_rows(db_path) == []


def test_a_lift_any_other_key_signs_is_refused(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """A key not the steward's, PUT under its own address, gets 403 bad_signature.

    The key is a stranger's: the suspended door's own PUTs get 403
    ``suspended`` before any signature is read. The suspension stands.
    """
    _suspended(shelf_client, door, steward)
    other = ShelfSigner.fresh()
    lift = stamped(notice("unsuspend", address=door.address), day=TODAY)

    response = put_shelf(shelf_client, other.address, other.record(lift))

    assert response.status_code == 403
    assert response.json() == {"error": "bad_signature"}
    assert _list(shelf_client, door).status_code == 403
