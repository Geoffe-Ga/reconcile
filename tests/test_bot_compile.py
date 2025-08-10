import py_compile
from pathlib import Path


def test_bot_and_main_compile() -> None:
    """The Discord bot modules should at least be syntactically valid.

    Previously ``reconcile_bot.bot`` had lost indentation which meant importing
    it (for example via ``python -m reconcile_bot.main``) crashed with an
    ``IndentationError``.  Compiling the modules here ensures a regression would
    be caught by the test-suite without requiring the ``discord`` package to be
    installed.
    """

    py_compile.compile(Path("reconcile_bot/bot.py"), doraise=True)
    py_compile.compile(Path("reconcile_bot/main.py"), doraise=True)
    py_compile.compile(Path("reconcile_bot/ui/views.py"), doraise=True)

