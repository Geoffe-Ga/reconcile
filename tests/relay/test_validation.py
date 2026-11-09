"""Bad input gets a constant 4xx and leaves the database untouched."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import pytest

from tests.relay.helpers import (
    BLOB_SIZES,
    OCTET_STREAM,
    blob,
    body_receiver,
    call,
    mailbox_id,
    put,
    row_count,
)

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from starlette.testclient import TestClient
    from starlette.types import ASGIApp

VALID_ID = "A" * 43


@pytest.fixture
def unchanged(db_path: Path, client: TestClient) -> Iterator[None]:
    """Assert, after the test, that the row count didn't move."""
    put(client, mailbox_id(), blob())  # one row, so "unchanged" isn't trivially 0
    before = row_count(db_path)
    yield
    assert row_count(db_path) == before


@pytest.mark.parametrize("size", BLOB_SIZES)
def test_each_bucket_size_is_accepted(
    client: TestClient, db_path: Path, size: int
) -> None:
    """Blobs of exactly 1, 4, 16 or 64 KiB are stored."""
    response = put(client, mailbox_id(), blob(size))

    assert response.status_code == 201
    assert row_count(db_path) == 1


@pytest.mark.parametrize(
    "size", [0, 1, 1023, 1025, 2048, 4095, 4097, 16383, 16385, 32768, 65535]
)
@pytest.mark.usefixtures("unchanged")
def test_a_blob_outside_the_buckets_is_refused(client: TestClient, size: int) -> None:
    """Any other size gets 400 invalid_size."""
    response = put(client, mailbox_id(), blob(size))

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_size"}


@pytest.mark.parametrize(
    "mailbox",
    [
        "A" * 42,
        "A" * 44,
        "A" * 42 + "+",
        "A" * 42 + "=",
        "A" * 42 + ".",
        "A" * 42 + "~",
        "A" * 42 + "é",
        "A" * 42 + "%20",
        VALID_ID + "%0A",
    ],
)
@pytest.mark.usefixtures("unchanged")
def test_a_malformed_mailbox_id_is_refused(client: TestClient, mailbox: str) -> None:
    """Only 43 base64url characters name a mailbox, for PUT and GET alike."""
    put_response = put(client, mailbox, blob())
    get_response = client.get(f"/v1/mailbox/{mailbox}")

    for response in (put_response, get_response):
        assert response.status_code == 400
        assert response.json() == {"error": "invalid_mailbox"}


@pytest.mark.usefixtures("unchanged")
def test_a_slash_in_the_mailbox_id_matches_no_route(client: TestClient) -> None:
    """A ``/`` splits the path, so no mailbox route matches at all."""
    response = put(client, "A" * 21 + "/" + "A" * 21, blob())

    assert response.status_code == 404


@pytest.mark.parametrize(
    "ttl", ["0", "31", "-1", "abc", "1.5", "", " 1", "1e1", "+1", "٣", "9" * 40]
)
@pytest.mark.usefixtures("unchanged")
def test_a_ttl_outside_one_to_thirty_days_is_refused(
    client: TestClient, ttl: str
) -> None:
    """``ttl_days`` must be a plain integer from 1 to 30."""
    response = put(client, mailbox_id(), blob(), ttl_days=ttl)

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_ttl"}


@pytest.mark.parametrize("ttl", ["1", "30", "07"])
def test_ttl_bounds_are_inclusive(client: TestClient, ttl: str) -> None:
    """One day and thirty days are both allowed."""
    assert put(client, mailbox_id(), blob(), ttl_days=ttl).status_code == 201


@pytest.mark.usefixtures("unchanged")
def test_a_body_over_the_cap_is_refused(client: TestClient) -> None:
    """A Content-Length over 65,536 gets 413 too_large."""
    response = put(client, mailbox_id(), blob(65537))

    assert response.status_code == 413
    assert response.json() == {"error": "too_large"}


@pytest.mark.parametrize("length", [b"65537", b"1048576", b"9" * 25])
def test_an_oversized_content_length_is_refused_unread(
    app: ASGIApp, db_path: Path, length: bytes
) -> None:
    """The body of an oversized PUT is never read."""
    receive, given = body_receiver(blob(1024))
    headers = [
        (b"content-type", b"application/octet-stream"),
        (b"content-length", length),
    ]

    result = asyncio.run(
        call(app, "PUT", f"/v1/mailbox/{VALID_ID}", receive=receive, headers=headers)
    )

    assert result.status == 413
    assert result.body == b'{"error":"too_large"}'
    assert given == []
    assert row_count(db_path) == 0


def test_a_missing_content_length_is_refused_unread(
    app: ASGIApp, db_path: Path
) -> None:
    """Without Content-Length the relay won't start reading."""
    receive, given = body_receiver(blob(1024))
    headers = [(b"content-type", b"application/octet-stream")]

    result = asyncio.run(
        call(app, "PUT", f"/v1/mailbox/{VALID_ID}", receive=receive, headers=headers)
    )

    assert result.status == 411
    assert result.body == b'{"error":"length_required"}'
    assert given == []
    assert row_count(db_path) == 0


@pytest.mark.usefixtures("unchanged")
def test_a_chunked_upload_is_refused(client: TestClient) -> None:
    """A streamed body with no declared length gets 411."""

    def chunks() -> Iterator[bytes]:
        """Yield one bucket in two pieces, so httpx sends it chunked."""
        yield blob(512)
        yield blob(512)

    response = client.put(
        f"/v1/mailbox/{mailbox_id()}", content=chunks(), headers=OCTET_STREAM
    )

    assert response.status_code == 411
    assert response.json() == {"error": "length_required"}


@pytest.mark.parametrize(
    "length", [b"abc", b"-1024", b"1e3", b"", b" 1024", b"\xd9\xa3"]
)
def test_a_malformed_content_length_is_refused_unread(
    app: ASGIApp, db_path: Path, length: bytes
) -> None:
    """A Content-Length that isn't plain digits gets 400 invalid_length."""
    receive, given = body_receiver(blob(1024))
    headers = [
        (b"content-type", b"application/octet-stream"),
        (b"content-length", length),
    ]

    result = asyncio.run(
        call(app, "PUT", f"/v1/mailbox/{VALID_ID}", receive=receive, headers=headers)
    )

    assert result.status == 400
    assert result.body == b'{"error":"invalid_length"}'
    assert given == []
    assert row_count(db_path) == 0


@pytest.mark.parametrize("length", [b"1000", b"0", b"65535"])
def test_a_declared_size_outside_the_buckets_is_refused_unread(
    app: ASGIApp, db_path: Path, length: bytes
) -> None:
    """A declared length that isn't a bucket is refused before the body is read."""
    receive, given = body_receiver(blob(int(length)))
    headers = [
        (b"content-type", b"application/octet-stream"),
        (b"content-length", length),
    ]

    result = asyncio.run(
        call(app, "PUT", f"/v1/mailbox/{VALID_ID}", receive=receive, headers=headers)
    )

    assert result.status == 400
    assert result.body == b'{"error":"invalid_size"}'
    assert given == []
    assert row_count(db_path) == 0


@pytest.mark.parametrize(
    "chunks",
    [
        (blob(1023),),
        (blob(512), blob(511)),
        (blob(1025),),
        (blob(1024), blob(1)),
    ],
)
def test_a_body_that_differs_from_its_content_length_is_refused(
    app: ASGIApp, db_path: Path, chunks: tuple[bytes, ...]
) -> None:
    """The body must be exactly as long as declared, never shorter or longer."""
    receive, _ = body_receiver(*chunks)
    headers = [
        (b"content-type", b"application/octet-stream"),
        (b"content-length", b"1024"),
    ]

    result = asyncio.run(
        call(app, "PUT", f"/v1/mailbox/{VALID_ID}", receive=receive, headers=headers)
    )

    assert result.status == 400
    assert result.body == b'{"error":"invalid_size"}'
    assert row_count(db_path) == 0


def test_a_body_in_several_chunks_is_stored_whole(app: ASGIApp, db_path: Path) -> None:
    """A body split across ASGI messages is reassembled before it's stored."""
    receive, _ = body_receiver(blob(1000, 0x01), blob(24, 0x02))
    headers = [
        (b"content-type", b"application/octet-stream"),
        (b"content-length", b"1024"),
    ]

    result = asyncio.run(
        call(app, "PUT", f"/v1/mailbox/{VALID_ID}", receive=receive, headers=headers)
    )

    assert result.status == 201
    assert row_count(db_path) == 1


def test_a_client_that_disconnects_mid_upload_stores_nothing(
    app: ASGIApp, db_path: Path
) -> None:
    """A dropped upload ends quietly, with no exception and no row."""
    receive, given = body_receiver()
    headers = [
        (b"content-type", b"application/octet-stream"),
        (b"content-length", b"1024"),
    ]

    result = asyncio.run(
        call(app, "PUT", f"/v1/mailbox/{VALID_ID}", receive=receive, headers=headers)
    )

    assert given == [{"type": "http.disconnect"}]
    assert result.status == 400
    assert result.body == b'{"error":"disconnected"}'
    assert row_count(db_path) == 0


@pytest.mark.parametrize(
    "content_type", [None, "text/plain", "application/json", "multipart/form-data"]
)
@pytest.mark.usefixtures("unchanged")
def test_a_body_that_isnt_an_octet_stream_is_refused(
    client: TestClient, content_type: str | None
) -> None:
    """A PUT must say ``application/octet-stream``."""
    headers = {} if content_type is None else {"content-type": content_type}

    response = client.put(
        f"/v1/mailbox/{mailbox_id()}", content=blob(), headers=headers
    )

    assert response.status_code == 415
    assert response.json() == {"error": "unsupported_media_type"}


@pytest.mark.parametrize(
    "content_type", ["Application/Octet-Stream", "application/octet-stream; x=y"]
)
def test_octet_stream_is_matched_like_a_media_type(
    client: TestClient, content_type: str
) -> None:
    """The media type is case-insensitive and may carry parameters."""
    response = client.put(
        f"/v1/mailbox/{mailbox_id()}",
        content=blob(),
        headers={"content-type": content_type},
    )

    assert response.status_code == 201


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("after", "-1"),
        ("after", "x"),
        ("after", "1.0"),
        ("after", ""),
        ("after", str(2**63)),
        ("limit", "0"),
        ("limit", "101"),
        ("limit", "x"),
        ("limit", ""),
    ],
)
def test_a_bad_cursor_or_page_size_is_refused(
    client: TestClient, name: str, value: str
) -> None:
    """``after`` must be 0 to 2**63-1, and ``limit`` 1 to 100."""
    response = client.get(f"/v1/mailbox/{mailbox_id()}", params={name: value})

    assert response.status_code == 400
    assert response.json() == {"error": f"invalid_{name}"}


@pytest.mark.parametrize(
    ("name", "value"),
    [("after", "0"), ("after", str(2**63 - 1)), ("limit", "1"), ("limit", "100")],
)
def test_cursor_and_page_size_bounds_are_inclusive(
    client: TestClient, name: str, value: str
) -> None:
    """The edges of each range are allowed."""
    response = client.get(f"/v1/mailbox/{mailbox_id()}", params={name: value})

    assert response.status_code == 200
