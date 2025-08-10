"""Test configuration for ensuring package imports.

This repository does not use a ``src`` layout and the tests are located in a
separate directory.  When ``pytest`` is executed as a console script the current
working directory might not be automatically added to ``sys.path`` which can
lead to ``ModuleNotFoundError`` for the ``reconcile_bot`` package.  To provide a
stable testing environment we explicitly insert the repository root into
``sys.path`` before any tests are collected.
"""

import os
import sys


# Add the repository root (the directory containing this file) to ``sys.path``
# if it is not already present.  This mirrors the behaviour of running the
# tests via ``python -m pytest`` where the working directory is automatically on
# the import path.
ROOT_DIR = os.path.abspath(os.path.dirname(__file__))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

