"""Tests for reconcile.main module."""

from reconcile.main import main


def test_main_runs() -> None:
    """Test that main() runs without error."""
    main()  # Should print "Hello from reconcile!"
