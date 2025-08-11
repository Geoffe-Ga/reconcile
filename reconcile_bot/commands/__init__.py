"""Utilities for dynamic submodule handling during tests."""

from __future__ import annotations

import sys
import types


class _CommandsModule(types.ModuleType):
    """Module type that re-registers submodules when accessed."""

    def __getattribute__(self, name: str) -> object:  # pragma: no cover - thin shim
        attr = types.ModuleType.__getattribute__(self, name)
        if isinstance(attr, types.ModuleType):
            fullname = f"{types.ModuleType.__getattribute__(self, '__name__')}.{name}"
            if fullname not in sys.modules:
                sys.modules[fullname] = attr
        return attr


sys.modules[__name__].__class__ = _CommandsModule

