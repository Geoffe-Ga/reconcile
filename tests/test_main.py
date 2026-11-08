"""Tests for reconcile.main module."""

import pytest

from reconcile.main import main


def test_main_prints_greeting(capsys: pytest.CaptureFixture[str]) -> None:
    """main() prints the placeholder greeting exactly."""
    main()
    assert capsys.readouterr().out == "Hello from reconcile!\n"
