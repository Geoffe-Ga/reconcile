"""The public shelf's routes (#484, docs/spec/listed-doors.md §4.2).

The shelf is on only while ``RECONCILE_RELAY_SHELF_STEWARD_KEY`` holds the
steward's public key. A PUT stores one record its address signed; a GET pages
every record in seq order. These are the first bodies the relay can read, and
it checks nothing about them beyond their size, their signature and the kind
it files them under.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import TYPE_CHECKING, Any

import pytest
from starlette.testclient import TestClient

from reconcile.relay.app import create_app
from reconcile.relay.purge import purge
from reconcile.relay.settings import Settings
from reconcile.relay.store import HELD_UNTIL_RELEASED, ShelfWhen
from tests.relay.helpers import (
    DAY,
    MINUTE,
    NOON,
    OCTET_STREAM,
    FakeClock,
    ShelfSigner,
    body_receiver,
    call,
    compact,
    entry,
    final_listing,
    listing,
    put_shelf,
    shelf_rows,
    sqlite_files,
    store_of,
)

if TYPE_CHECKING:
    from pathlib import Path

    from starlette.types import ASGIApp

TODAY = int(NOON // DAY)
NOW_MINUTE = int(NOON // MINUTE)
WEEK = 7 * 1440  # minutes
WITHDRAW = {"v": 1, "kind": "withdraw", "id": "d" * 43}


def _seqs(response: Any) -> list[int]:
    """The seqs of a GET response's records, in the order returned."""
    return [record["seq"] for record in response.json()["records"]]


def _live(client: TestClient, signer: ShelfSigner, body: dict[str, Any]) -> Any:
    """PUT a first listing, then clear its hold as a release would (#488).

    These tests are about the routes, so the hold is cleared in the store,
    with no notice that would take a seq; ``test_shelf_held.py`` has the
    notice itself.
    """
    response = put_shelf(client, signer.address, signer.record(body))
    store_of(client.app).release(signer.address)
    return response


# --- Off without the steward's key -----------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("PUT", f"/v1/shelf/{'A' * 43}"),
        ("PUT", "/v1/shelf/not-an-address"),
        ("GET", "/v1/shelf"),
        ("GET", "/v1/shelf?after=x&limit=0"),
    ],
)
def test_without_the_steward_key_every_shelf_route_is_unavailable(
    client: TestClient, method: str, path: str
) -> None:
    """Unset, the routes answer 404 shelf_unavailable before checking anything else."""
    response = client.request(method, path, content=b"x", headers=OCTET_STREAM)

    assert response.status_code == 404
    assert response.json() == {"error": "shelf_unavailable"}


def test_without_the_steward_key_nothing_is_stored(
    client: TestClient, db_path: Path, door: ShelfSigner
) -> None:
    """A good record PUT to a relay with the shelf off leaves no row."""
    put_shelf(client, door.address, door.record(listing()))

    assert shelf_rows(db_path) == []


# --- PUT --------------------------------------------------------------------


def test_put_stores_a_listing_and_returns_its_seq(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner
) -> None:
    """201 {"seq": n}; the row holds the address, kind, no ref, and its times."""
    record = door.record(listing())

    response = put_shelf(shelf_client, door.address, record)

    assert response.status_code == 201
    assert response.json() == {"seq": 1}
    assert shelf_rows(db_path) == [
        (
            1,
            door.address,
            "listing",
            "",
            len(record),
            NOW_MINUTE,
            TODAY + 31,
            HELD_UNTIL_RELEASED,
        )
    ]


@pytest.mark.parametrize("body", [entry("e" * 43), {**WITHDRAW, "id": "e" * 43}])
def test_an_entry_or_withdraw_is_filed_under_its_id(
    shelf_client: TestClient, db_path: Path, door: ShelfSigner, body: dict[str, Any]
) -> None:
    """``ref`` is the id an entry or a withdraw names."""
    _room_for(shelf_client, door, body)

    response = put_shelf(shelf_client, door.address, door.record(body))

    assert response.status_code == 201
    row = shelf_rows(db_path)[-1]
    assert row[2:4] == (body["kind"], "e" * 43)


def test_put_refuses_a_record_its_address_did_not_sign(
    shelf_client: TestClient, door: ShelfSigner, db_path: Path
) -> None:
    """A record PUT under any other address gets 403 bad_signature."""
    other = "A" * 43

    response = put_shelf(shelf_client, other, door.record(listing()))

    assert response.status_code == 403
    assert response.json() == {"error": "bad_signature"}
    assert shelf_rows(db_path) == []


@pytest.mark.parametrize("at", [0, 63, 64, -1])
def test_put_refuses_a_record_with_any_byte_changed(
    shelf_client: TestClient, door: ShelfSigner, at: int
) -> None:
    """A changed byte in the signature or the message fails the check."""
    record = bytearray(door.record(listing()))
    record[at] ^= 0x01

    response = put_shelf(shelf_client, door.address, bytes(record))

    assert (response.status_code, response.json()) == (403, {"error": "bad_signature"})


def test_put_refuses_a_signature_made_for_another_purpose(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """A signature under a door page's tag is no shelf record's."""
    message = compact(listing())
    record = door.key.sign(b"reconcile/v1/door-page\x00" + message) + message

    response = put_shelf(shelf_client, door.address, record)

    assert (response.status_code, response.json()) == (403, {"error": "bad_signature"})


@pytest.mark.parametrize(
    "address",
    [
        "A" * 42,
        "A" * 44,
        "A" * 42 + "+",
        "A" * 42 + "=",
        # 43 characters carry 258 bits: a set spare bit spells the same key twice.
        "A" * 42 + "B",
    ],
)
def test_put_refuses_an_address_that_is_not_a_canonical_key(
    shelf_client: TestClient, door: ShelfSigner, address: str
) -> None:
    """The address is 43 canonical base64url characters, else 400 invalid_address."""
    response = put_shelf(shelf_client, address, door.record(listing()))

    assert (response.status_code, response.json()) == (
        400,
        {"error": "invalid_address"},
    )


def test_put_refuses_a_body_that_is_not_an_octet_stream(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """The body is declared ``application/octet-stream``, as a blob's is."""
    response = shelf_client.put(
        f"/v1/shelf/{door.address}",
        content=door.record(listing()),
        headers={"content-type": "application/json"},
    )

    assert (response.status_code, response.json()) == (
        415,
        {"error": "unsupported_media_type"},
    )


def _padded_body(
    signer: ShelfSigner, body: dict[str, Any], size: int
) -> dict[str, Any]:
    """``body`` with one string field padded so its signed record is ``size``."""
    record = signer.record(body)
    key = {"entry": "text", "listing": "name", "withdraw": "id"}[body["kind"]]
    return {**body, key: body[key] + "x" * (size - len(record))}


def _padded(signer: ShelfSigner, body: dict[str, Any], size: int) -> bytes:
    """``body`` signed, with one string field padded so the record is ``size``."""
    return signer.record(_padded_body(signer, body, size))


def _room_for(client: TestClient, door: ShelfSigner, body: dict[str, Any]) -> None:
    """What ``body`` needs first (#431): a listing, and for a withdraw its entry."""
    if body["kind"] != "listing":
        put_shelf(client, door.address, door.record(listing()))
    if body["kind"] == "withdraw":
        put_shelf(client, door.address, door.record(entry(body["id"])))


SIZES = [(listing(), 1024), (WITHDRAW, 1024), (entry(), 4096)]


@pytest.mark.parametrize(("body", "size"), SIZES)
def test_put_takes_a_record_of_exactly_its_size(
    shelf_client: TestClient, door: ShelfSigner, body: dict[str, Any], size: int
) -> None:
    """The limits are inclusive."""
    padded = _padded_body(door, body, size)
    record = door.record(padded)
    assert len(record) == size
    _room_for(shelf_client, door, padded)

    assert put_shelf(shelf_client, door.address, record).status_code == 201


@pytest.mark.parametrize(("body", "size"), SIZES)
def test_put_refuses_a_record_over_its_size(
    shelf_client: TestClient, door: ShelfSigner, body: dict[str, Any], size: int
) -> None:
    """A listing or withdraw is at most 1,024 bytes, an entry at most 4,096."""
    record = _padded(door, body, size + 1)
    assert len(record) == size + 1

    response = put_shelf(shelf_client, door.address, record)

    assert (response.status_code, response.json()) == (413, {"error": "too_large"})


def test_put_refuses_a_declared_length_over_4096_before_reading(
    shelf_app: ASGIApp, door: ShelfSigner
) -> None:
    """Content-Length over the largest record gets 413 with no byte read."""
    receive, given = body_receiver(b"x" * 4097)

    result = _run(
        shelf_app,
        door.address,
        receive,
        [(b"content-type", b"application/octet-stream"), (b"content-length", b"4097")],
    )

    assert (result.status, result.body) == (413, b'{"error":"too_large"}')
    assert given == []


def test_put_needs_a_declared_length(shelf_app: ASGIApp, door: ShelfSigner) -> None:
    """A body with no Content-Length gets 411."""
    receive, _ = body_receiver(door.record(listing()))

    result = _run(
        shelf_app,
        door.address,
        receive,
        [(b"content-type", b"application/octet-stream")],
    )

    assert (result.status, result.body) == (411, b'{"error":"length_required"}')


def _run(
    app: ASGIApp, address: str, receive: Any, headers: list[tuple[bytes, bytes]]
) -> Any:
    """One raw ASGI PUT to ``address``'s shelf route."""
    return asyncio.run(
        call(app, "PUT", f"/v1/shelf/{address}", receive=receive, headers=headers)
    )


@pytest.mark.parametrize(
    "message",
    [
        b"",
        b"not json",
        b"\xff\xfe",
        b"[]",
        b'"listing"',
        compact({**listing(), "v": 2}),
        compact({**listing(), "v": True}),
        compact({"kind": "listing"}),
        compact({**listing(), "kind": "notice"}),
        compact({**listing(), "kind": "pitch"}),
        compact({**listing(), "kind": 1}),
        compact({"v": 1, "kind": "entry", "title": "t", "text": ""}),
        compact({**entry(), "id": 7}),
        compact({"v": 1, "kind": "withdraw"}),
        compact({**listing(), "open": "yes"}),
        compact({**listing(), "open": None}),
        compact({"v": 1, "kind": "listing", "open": False}),
        compact({"v": 1, "kind": "listing", "open": False, "final": False}),
        compact({"v": 1, "kind": "listing", "open": False, "final": 1}),
        b'{"v":1,"kind":"listing","kind":"entry","id":"x"}',
    ],
)
def test_put_refuses_a_signed_body_that_is_no_record(
    shelf_client: TestClient, door: ShelfSigner, db_path: Path, message: bytes
) -> None:
    """Signed, but not a v1 listing, entry or withdraw: 400 invalid_record."""
    response = put_shelf(shelf_client, door.address, door.sign(message))

    assert (response.status_code, response.json()) == (400, {"error": "invalid_record"})
    assert shelf_rows(db_path) == []


@pytest.mark.parametrize("size", [0, 1, 64])
def test_put_refuses_a_body_too_short_to_hold_a_signature_and_a_message(
    shelf_client: TestClient, door: ShelfSigner, size: int
) -> None:
    """At most 64 bytes is a signature at best, with nothing signed."""
    response = put_shelf(shelf_client, door.address, b"\x00" * size)

    assert (response.status_code, response.json()) == (400, {"error": "invalid_record"})


# --- One listing per address (#486, listed-doors.md §4.2) -------------------


def test_a_later_listing_replaces_the_address_earlier_one_in_its_place(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock, db_path: Path
) -> None:
    """One row per address: a new copy keeps the first one's seq, with its own times."""
    _live(shelf_client, door, listing())
    clock.advance(7 * DAY)
    renamed = door.record(listing("Oak Street Tenants Union"))

    response = put_shelf(shelf_client, door.address, renamed)

    assert (response.status_code, response.json()) == (201, {"seq": 1})
    assert shelf_rows(db_path) == [
        (1, door.address, "listing", "", len(renamed), NOW_MINUTE + WEEK, TODAY + 38, 0)
    ]
    [served] = shelf_client.get("/v1/shelf").json()["records"]
    assert base64.b64decode(served["data"]) == renamed


def test_a_listing_never_replaces_another_address_listing(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """Each address keeps its own listing."""
    other = ShelfSigner.fresh()
    _live(shelf_client, door, listing())

    response = _live(shelf_client, other, listing("Birch"))

    assert response.json() == {"seq": 2}
    assert _seqs(shelf_client.get("/v1/shelf")) == [1, 2]


def test_a_listing_lapses_thirty_days_after_its_last_post(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock, db_path: Path
) -> None:
    """Each post renews the 30 days; without one the listing lapses and is purged."""
    _live(shelf_client, door, listing())
    clock.advance(20 * DAY)
    put_shelf(shelf_client, door.address, door.record(listing()))
    clock.advance(30 * DAY)

    assert _seqs(shelf_client.get("/v1/shelf")) == [1]
    clock.advance(DAY)
    assert _seqs(shelf_client.get("/v1/shelf")) == []
    purge(store_of(shelf_client.app), clock())
    assert shelf_rows(db_path) == []


def test_a_final_listing_deletes_the_address_entries_and_stands(
    shelf_client: TestClient, door: ShelfSigner, db_path: Path
) -> None:
    """The final copy takes the listing's row; the entries and withdraws go."""
    other = ShelfSigner.fresh()
    _live(shelf_client, door, listing())
    put_shelf(shelf_client, door.address, door.record(entry("e" * 43)))
    put_shelf(shelf_client, door.address, door.record({**WITHDRAW, "id": "e" * 43}))
    put_shelf(shelf_client, other.address, other.record(listing("Birch")))
    put_shelf(shelf_client, other.address, other.record(entry("e" * 43)))
    final = door.record(final_listing())

    response = put_shelf(shelf_client, door.address, final)

    assert (response.status_code, response.json()) == (201, {"seq": 1})
    assert [row[:3] for row in shelf_rows(db_path)] == [
        (1, door.address, "listing"),
        (4, other.address, "listing"),
        (5, other.address, "entry"),
    ]
    served = shelf_client.get("/v1/shelf").json()["records"]
    assert base64.b64decode(served[0]["data"]) == final


def test_a_final_listing_with_none_before_it_stands_alone(
    shelf_client: TestClient, door: ShelfSigner, db_path: Path
) -> None:
    """A door that closes before any listing reached the relay still posts its end."""
    response = put_shelf(shelf_client, door.address, door.record(final_listing()))

    assert response.status_code == 201
    assert [row[2] for row in shelf_rows(db_path)] == ["listing"]


def test_no_open_listing_follows_a_final_one(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock, db_path: Path
) -> None:
    """409 listing_final, and the final copy stays; a final copy again renews it."""
    final = door.record(final_listing())
    put_shelf(shelf_client, door.address, door.record(listing()))
    put_shelf(shelf_client, door.address, final)

    reopened = put_shelf(shelf_client, door.address, door.record(listing()))
    clock.advance(7 * DAY)
    renewed = put_shelf(shelf_client, door.address, final)

    assert (reopened.status_code, reopened.json()) == (
        409,
        {"error": "listing_final"},
    )
    assert renewed.status_code == 201
    held = HELD_UNTIL_RELEASED  # never released, so its hold stays
    assert shelf_rows(db_path) == [
        (
            1,
            door.address,
            "listing",
            "",
            len(final),
            NOW_MINUTE + WEEK,
            TODAY + 38,
            held,
        )
    ]


# --- Caps -------------------------------------------------------------------


def _small_shelf_client(
    db_path: Path, clock: FakeClock, steward: ShelfSigner, cap: int
) -> TestClient:
    """A client for a shelf of at most ``cap`` bytes."""
    settings = Settings(
        db_path=db_path, shelf_steward_key=steward.address, max_shelf_bytes=cap
    )
    return TestClient(create_app(settings, clock))


def test_the_shelf_is_full_past_its_byte_cap(
    db_path: Path, clock: FakeClock, steward: ShelfSigner, door: ShelfSigner
) -> None:
    """Past its cap a PUT gets 507 shelf_full; up to the cap is fine."""
    first = door.record(listing())
    second = door.record(entry())
    with _small_shelf_client(
        db_path, clock, steward, len(first) + len(second)
    ) as client:
        assert put_shelf(client, door.address, first).status_code == 201
        assert put_shelf(client, door.address, second).status_code == 201
        response = put_shelf(client, door.address, door.record(WITHDRAW))
        store_of(client.app).close()

    assert (response.status_code, response.json()) == (507, {"error": "shelf_full"})
    assert [row[2] for row in shelf_rows(db_path)] == ["listing", "entry"]


def test_expired_records_free_their_bytes(
    db_path: Path, clock: FakeClock, steward: ShelfSigner, door: ShelfSigner
) -> None:
    """The cap counts unexpired records only, as a GET does."""
    record = door.record(listing())
    with _small_shelf_client(db_path, clock, steward, len(record)) as client:
        assert put_shelf(client, door.address, record).status_code == 201
        assert put_shelf(client, door.address, record).status_code == 507
        clock.advance(31 * DAY)
        response = put_shelf(client, door.address, record)
        store_of(client.app).close()

    assert response.status_code == 201


def test_a_full_database_refuses_a_shelf_put(
    db_path: Path, clock: FakeClock, steward: ShelfSigner, door: ShelfSigner
) -> None:
    """The relay's storage cap applies to the shelf as to every write."""
    settings = Settings(
        db_path=db_path, shelf_steward_key=steward.address, max_db_bytes=1
    )
    with TestClient(create_app(settings, clock)) as client:
        response = put_shelf(client, door.address, door.record(listing()))
        store_of(client.app).close()

    assert (response.status_code, response.json()) == (507, {"error": "storage_full"})


# --- GET --------------------------------------------------------------------


def test_get_returns_every_record_in_seq_order_with_its_address(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """Records from any address, oldest first, each with its bytes in base64."""
    other = ShelfSigner.fresh()
    first = door.record(listing())
    clock.advance(5 * MINUTE)
    _live(shelf_client, door, listing())
    second = other.record(listing("Birch Ave Tenants"))
    _live(shelf_client, other, listing("Birch Ave Tenants"))

    response = shelf_client.get("/v1/shelf")

    assert response.status_code == 200
    page = response.json()
    assert page["records"] == [
        {
            "seq": 1,
            "received": NOW_MINUTE + 5,
            "address": door.address,
            "data": base64.b64encode(first).decode(),
        },
        {
            "seq": 2,
            "received": NOW_MINUTE + 5,
            "address": other.address,
            "data": base64.b64encode(second).decode(),
        },
    ]
    assert page["now"] == NOW_MINUTE + 5
    assert page["instance"] == store_of(shelf_client.app).instance


def test_get_pages_after_a_seq(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """``after`` and ``limit`` page the shelf as they page a mailbox."""
    _live(shelf_client, door, listing())
    for label in "abcd":
        put_shelf(shelf_client, door.address, door.record(entry(label * 43)))
        clock.advance(DAY)  # an address posts one new entry a day (#431)

    assert _seqs(shelf_client.get("/v1/shelf", params={"after": 1, "limit": 2})) == [
        2,
        3,
    ]
    assert _seqs(shelf_client.get("/v1/shelf", params={"after": 3})) == [4, 5]
    assert _seqs(shelf_client.get("/v1/shelf", params={"after": 5})) == []


@pytest.mark.parametrize(
    ("params", "code"),
    [
        ({"after": "-1"}, "invalid_after"),
        ({"after": "x"}, "invalid_after"),
        ({"limit": "0"}, "invalid_limit"),
        ({"limit": "101"}, "invalid_limit"),
    ],
)
def test_get_refuses_a_bad_page(
    shelf_client: TestClient, params: dict[str, str], code: str
) -> None:
    """The mailbox's paging rules, word for word."""
    response = shelf_client.get("/v1/shelf", params=params)

    assert (response.status_code, response.json()) == (400, {"error": code})


def test_a_record_is_kept_thirty_days_then_purged(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock, db_path: Path
) -> None:
    """A GET skips a record from its expiry day; the daily purge deletes it."""
    _live(shelf_client, door, listing())

    clock.advance(30 * DAY)
    assert _seqs(shelf_client.get("/v1/shelf")) == [1]
    clock.advance(DAY)
    assert _seqs(shelf_client.get("/v1/shelf")) == []
    assert len(shelf_rows(db_path)) == 1
    purge(store_of(shelf_client.app), clock())
    assert shelf_rows(db_path) == []


def test_get_leaves_out_a_held_record(
    shelf_client: TestClient, door: ShelfSigner, clock: FakeClock
) -> None:
    """A row held until a later minute isn't served until that minute (#489 holds)."""
    _live(shelf_client, door, listing())
    store = store_of(shelf_client.app)
    store.add_shelf(
        door.address,
        "entry",
        "d" * 43,
        b"held",
        ShelfWhen(received=NOW_MINUTE, expiry=TODAY + 31, held_until=NOW_MINUTE + 10),
    )

    assert _seqs(shelf_client.get("/v1/shelf")) == [1]
    clock.advance(10 * MINUTE)
    assert _seqs(shelf_client.get("/v1/shelf")) == [1, 2]


def test_the_shelf_and_the_mailboxes_are_apart(
    shelf_client: TestClient, door: ShelfSigner
) -> None:
    """A shelf record never shows in a mailbox of its name, nor a blob on the shelf."""
    record = door.record(listing())
    _live(shelf_client, door, listing())
    shelf_client.put(
        f"/v1/mailbox/{door.address}", content=b"\x01" * 1024, headers=OCTET_STREAM
    )

    blobs = shelf_client.get(f"/v1/mailbox/{door.address}").json()["records"]
    shelved = shelf_client.get("/v1/shelf").json()["records"]

    assert [base64.b64decode(r["data"]) for r in blobs] == [b"\x01" * 1024]
    assert [base64.b64decode(r["data"]) for r in shelved] == [record]


# --- Privacy ----------------------------------------------------------------

CANARY = "203.0.113.9"
CLIENT_ADDRESSES = ["198.51.100.29", "192.0.2.49", "2001:db8::9"]


def test_shelf_requests_leave_no_client_address(
    shelf_app: ASGIApp,
    db_path: Path,
    door: ShelfSigner,
    capfd: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Shelf PUTs and GETs, held ones too, leave no client address anywhere."""
    caplog.set_level(logging.DEBUG)
    needles = [CANARY, *CLIENT_ADDRESSES]
    forwarded = {"x-forwarded-for": CANARY, "x-real-ip": CANARY}
    for address in CLIENT_ADDRESSES:
        client = TestClient(shelf_app, client=(address, 41000))
        stored = put_shelf(
            client, door.address, door.record(listing()), headers=forwarded
        )
        page = client.get("/v1/shelf", headers=forwarded)
        held = client.get("/v1/shelf/held", headers=forwarded)
        assert (stored.status_code, page.status_code, held.status_code) == (
            201,
            200,
            200,
        )
        assert not [n for n in needles if n.encode() in page.content + held.content]
    out, err = capfd.readouterr()
    logged = "\n".join(record.getMessage() for record in caplog.records)

    for name, data in sqlite_files(db_path).items():
        assert not [n for n in needles if n.encode() in data], name
    assert not [n for n in needles if n in out + err + logged]
