"""Held mode and the steward's release (#488, docs/spec/listed-doors.md §4.2, §6.1).

``RECONCILE_RELAY_SHELF_MODE`` is ``held``, the only mode built: an address's
first listing, and everything under it, is stored held until the steward
releases it. ``GET /v1/shelf`` leaves held records out, and
``GET /v1/shelf/held`` returns only them, for the steward's console. A
``release`` notice is PUT under the configured steward key and signed by it;
any other signer gets 403 ``bad_signature``. A release clears its address's
hold, and lasts as long as the listing it released.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from reconcile.relay.purge import purge
from reconcile.relay.store import HELD_UNTIL_RELEASED
from tests.relay.helpers import (
    DAY,
    MINUTE,
    NOON,
    OCTET_STREAM,
    FakeClock,
    ShelfSigner,
    entry,
    final_listing,
    listing,
    put_shelf,
    shelf_rows,
    store_of,
)

if TYPE_CHECKING:
    from pathlib import Path

    from starlette.testclient import TestClient

TODAY = int(NOON // DAY)
HELD = HELD_UNTIL_RELEASED


def release(address: str) -> dict[str, Any]:
    """A release notice's body, naming ``address``."""
    return {"v": 1, "kind": "notice", "act": "release", "address": address}


def _addresses(response: Any) -> list[str]:
    """The addresses of a GET response's records, in the order returned."""
    return [record["address"] for record in response.json()["records"]]


def _held(response: Any) -> list[int]:
    """The seqs of a held GET response's records."""
    return [record["seq"] for record in response.json()["records"]]


# --- Held ------------------------------------------------------------------


def test_a_new_listing_is_held_until_the_steward_releases_it(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """The issue's example: held, then live beside the notice that released it."""
    put_shelf(shelf_client, door.address, door.record(listing()))
    assert shelf_client.get("/v1/shelf").json()["records"] == []

    response = put_shelf(
        shelf_client, steward.address, steward.record(release(door.address))
    )

    assert response.status_code == 201
    assert _addresses(shelf_client.get("/v1/shelf")) == [
        door.address,
        steward.address,
    ]


def test_a_held_listing_and_everything_under_it_is_stored_held(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner
) -> None:
    """The first listing, its later copy and its entry all wait, until released."""
    put_shelf(shelf_client, door.address, door.record(listing()))
    put_shelf(shelf_client, door.address, door.record(listing("Oak St Union")))
    assert (
        put_shelf(shelf_client, door.address, door.record(entry())).status_code == 201
    )

    assert [row[-1] for row in shelf_rows(db_path)] == [HELD, HELD]
    assert shelf_client.get("/v1/shelf").json()["records"] == []


def test_the_held_route_returns_held_records_only(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """``GET /v1/shelf/held`` has the GET's shape and only what it leaves out."""
    other = ShelfSigner.fresh()
    put_shelf(shelf_client, door.address, door.record(listing()))
    put_shelf(shelf_client, other.address, other.record(listing("Elm Co-op")))
    put_shelf(shelf_client, steward.address, steward.record(release(other.address)))

    held = shelf_client.get("/v1/shelf/held").json()

    assert set(held) == {"records", "now", "instance"}
    assert held["now"] == int(NOON // MINUTE)
    assert held["instance"] == store_of(shelf_client.app).instance
    assert [r["address"] for r in held["records"]] == [door.address]
    assert set(held["records"][0]) == {"seq", "received", "address", "data"}
    assert _addresses(shelf_client.get("/v1/shelf")) == [other.address, steward.address]


def test_the_held_route_pages_after_a_seq(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """``after`` and ``limit`` page held records as they page the rest."""
    put_shelf(shelf_client, door.address, door.record(listing()))
    put_shelf(shelf_client, door.address, door.record(entry()))

    assert _held(shelf_client.get("/v1/shelf/held?limit=1")) == [1]
    assert _held(shelf_client.get("/v1/shelf/held?after=1")) == [2]


def test_the_held_route_is_off_without_the_steward_key(client: TestClient) -> None:
    """Unset, it answers 404 shelf_unavailable, as every shelf route does."""
    response = client.get("/v1/shelf/held")

    assert response.status_code == 404
    assert response.json() == {"error": "shelf_unavailable"}


def test_the_held_route_refuses_a_bad_page(shelf_client: TestClient) -> None:
    """A malformed ``after`` gets the GET's own 400."""
    response = shelf_client.get("/v1/shelf/held?after=x")

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_after"}


# --- Release ---------------------------------------------------------------


def test_a_release_frees_the_address_records_and_what_follows(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """Its listing and entries go live, and a later entry is stored live."""
    put_shelf(shelf_client, door.address, door.record(listing()))
    put_shelf(shelf_client, door.address, door.record(entry("e" * 43)))
    put_shelf(shelf_client, steward.address, steward.record(release(door.address)))
    put_shelf(shelf_client, door.address, door.record(listing("Oak St Union")))

    rows = shelf_rows(db_path)

    assert [(row[2], row[3], row[-1]) for row in rows] == [
        ("listing", "", 0),
        ("entry", "e" * 43, 0),
        ("notice", door.address, 0),
    ]
    assert shelf_client.get("/v1/shelf/held").json()["records"] == []


def test_a_release_frees_only_the_address_it_names(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """Another held address stays held."""
    other = ShelfSigner.fresh()
    put_shelf(shelf_client, door.address, door.record(listing()))
    put_shelf(shelf_client, other.address, other.record(listing("Elm Co-op")))

    put_shelf(shelf_client, steward.address, steward.record(release(door.address)))

    assert _addresses(shelf_client.get("/v1/shelf/held")) == [other.address]


def test_a_notice_is_kept_180_days(
    shelf_client: TestClient, db_path: Path, steward: ShelfSigner
) -> None:
    """A notice expires 180 whole days after the day it arrived (§4.2, proposed)."""
    put_shelf(shelf_client, steward.address, steward.record(release("A" * 43)))

    assert shelf_rows(db_path)[0][5:] == (int(NOON // MINUTE), TODAY + 181, 0)


def test_a_release_lasts_as_long_as_the_listing_it_released(
    shelf_client: TestClient,
    db_path: Path,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """A renewed listing carries its release's expiry with it, never shortening it."""
    put_shelf(shelf_client, door.address, door.record(listing()))
    put_shelf(shelf_client, steward.address, steward.record(release(door.address)))
    clock.advance(100 * DAY)
    put_shelf(shelf_client, door.address, door.record(listing()))
    assert shelf_rows(db_path)[1][6] == TODAY + 181  # still the notice's own
    clock.advance(60 * DAY)
    put_shelf(shelf_client, door.address, door.record(listing()))
    assert shelf_rows(db_path)[1][6] == TODAY + 160 + 31
    clock.advance(30 * DAY)
    put_shelf(shelf_client, door.address, door.record(listing()))

    assert shelf_rows(db_path)[1][6] == TODAY + 190 + 31
    purge(store_of(shelf_client.app), clock())
    assert _addresses(shelf_client.get("/v1/shelf")) == [door.address, steward.address]


def test_a_listing_that_lapsed_is_held_again(
    shelf_client: TestClient,
    door: ShelfSigner,
    steward: ShelfSigner,
    clock: FakeClock,
) -> None:
    """Once its row is purged, the address's next listing is a first listing."""
    put_shelf(shelf_client, door.address, door.record(listing()))
    put_shelf(shelf_client, steward.address, steward.record(release(door.address)))
    clock.advance(31 * DAY)
    purge(store_of(shelf_client.app), clock())

    put_shelf(shelf_client, door.address, door.record(listing()))

    assert _addresses(shelf_client.get("/v1/shelf/held")) == [door.address]


def test_a_final_listing_keeps_its_address_hold(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """A held door that closes stays out of the shelf's GET."""
    put_shelf(shelf_client, door.address, door.record(listing()))

    put_shelf(shelf_client, door.address, door.record(final_listing()))

    assert shelf_client.get("/v1/shelf").json()["records"] == []
    assert _held(shelf_client.get("/v1/shelf/held")) == [1]


# --- Who may sign a notice -------------------------------------------------


def test_a_notice_signed_by_any_other_key_is_refused(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner
) -> None:
    """A door that signs a release under its own address gets 403 bad_signature."""
    put_shelf(shelf_client, door.address, door.record(listing()))

    response = put_shelf(shelf_client, door.address, door.record(release(door.address)))

    assert response.status_code == 403
    assert response.json() == {"error": "bad_signature"}
    assert [row[2] for row in shelf_rows(db_path)] == ["listing"]
    assert shelf_client.get("/v1/shelf").json()["records"] == []


def test_a_notice_under_the_steward_address_signed_by_another_is_refused(
    shelf_client: TestClient, door: ShelfSigner, steward: ShelfSigner
) -> None:
    """The signature must be the steward's own."""
    response = put_shelf(
        shelf_client, steward.address, door.record(release(door.address))
    )

    assert response.status_code == 403
    assert response.json() == {"error": "bad_signature"}


@pytest.mark.parametrize(
    "body",
    [
        {"v": 1, "kind": "notice", "act": "hold", "address": "A" * 43},
        {"v": 1, "kind": "notice", "act": "uphold", "address": "A" * 43},
        {"v": 1, "kind": "notice", "act": "suspend", "address": "A" * 43},
        {"v": 1, "kind": "notice", "act": "pause"},
        {"v": 1, "kind": "notice", "act": "release"},
        {"v": 1, "kind": "notice", "act": "release", "address": "not-a-key"},
        {"v": 1, "kind": "notice", "act": "release", "address": 7},
        {"v": 1, "kind": "notice", "address": "A" * 43},
    ],
)
def test_the_relay_takes_only_a_release_naming_a_key(
    shelf_client: TestClient, db_path: Path, steward: ShelfSigner, body: dict[str, Any]
) -> None:
    """Later notices come with #489; until then they, and a bad release, are none."""
    response = put_shelf(shelf_client, steward.address, steward.record(body))

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_record"}
    assert shelf_rows(db_path) == []


def test_a_notice_is_at_most_1024_bytes(
    shelf_client: TestClient, steward: ShelfSigner
) -> None:
    """A notice is a small record (§4.1)."""
    body = {**release("A" * 43), "pad": "x" * 1000}

    response = put_shelf(shelf_client, steward.address, steward.record(body))

    assert response.status_code == 413
    assert response.json() == {"error": "too_large"}


def test_a_put_to_the_held_path_is_no_address(shelf_client: TestClient) -> None:
    """``held`` is a read route's name, not an address a record can be PUT under."""
    response = shelf_client.put("/v1/shelf/held", content=b"x", headers=OCTET_STREAM)

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_address"}
