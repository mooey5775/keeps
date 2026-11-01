from __future__ import annotations

from typing import Any


def resolve_nanopokerlib_game_module(game_name: str) -> Any:
    # Keeps: our game (keeps_bot/vrpo/game.py) instead of a nanopokerlib one; nanopokerlib
    # is imported only for its own games.
    if str(game_name).strip() == "keeps":
        from keeps_bot.vrpo import game as keeps_game
        return keeps_game
    import nanopokerlib as npl

    normalized_game_name = str(game_name).strip()
    if normalized_game_name.startswith("nanopokerlib."):
        normalized_game_name = normalized_game_name[len("nanopokerlib.") :]
    parts = [part for part in normalized_game_name.split(".") if part]
    if not parts:
        raise ValueError("game_name must be a non-empty nanopokerlib module path.")

    resolved: Any = npl
    for part in parts:
        if not hasattr(resolved, part):
            raise ValueError(f"Unknown game '{game_name}' in nanopokerlib.")
        resolved = getattr(resolved, part)
    return resolved


def extract_game_identifier(game: object) -> str:
    identifier = getattr(game, "GAME_IDENTIFIER", None)
    if identifier is None:
        raise ValueError(
            "Game module is missing GAME_IDENTIFIER. "
            "Ensure the game module/adapter exposes a canonical GAME_IDENTIFIER."
        )
    return str(identifier)


def resolve_nanopokerlib_game_identifier(game_name: str) -> str:
    return extract_game_identifier(resolve_nanopokerlib_game_module(game_name))


__all__ = [
    "extract_game_identifier",
    "resolve_nanopokerlib_game_identifier",
    "resolve_nanopokerlib_game_module",
]
