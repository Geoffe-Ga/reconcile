"""Test configuration for ensuring package imports."""

import os
import sys

# Add the repository root (the directory containing this file) to ``sys.path``
# if it is not already present.  This mirrors the behaviour of running the
# tests via ``python -m pytest`` where the working directory is automatically on
# the import path.
ROOT_DIR = os.path.abspath(os.path.dirname(__file__))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)
