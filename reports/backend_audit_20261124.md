# Backend audit — account / battle / shop — 2026-11-24

Agent: `/root/backend_acceptance_auditor`. Scope: `server/` only. No protocol guessing; changes are additive and fully server-side.

## State-machine review

| Area | Coverage found | Verdict |
| --- | --- | --- |
| Account | `register` / `login` / `GET /accounts/me` — usernames, tokens, balance, inventory | Solid. Local-session tokens and Bearer both resolve. |
| Battle | `rooms` (create/join/ready) → `battles` (start/frame/settle/get) | Correct owner-only start, ≥2 members ready gate, participant-only frame/settle/get. |
| Shop | `items` / `profile` / `purchase` | Price×quantity overflow checked, balance guard, order recorded, inventory updated. |
| Local session | `POST /local/session` + `/game/events` Bearer/`localToken`/default fallback | Working; loopback-only by design. |

## Gaps found → fixed

- **`/game/events` always returned `{"events":[]}`** — no domain activity ever surfaced to a polling client, so the real client would observe a permanently empty feed after login/room/battle/shop. Fixed: added a bounded `DomainEvent` ledger (id-scoped, `accountId`-filtered, 10k cap) pushed on register/login/room-create/join/ready/battle-start/frame/settle/purchase. `game_events` now returns `events` for `id > after`.
- **No room discovery** — a lobby client could not list rooms. Added `GET /rooms` (auth-gated) returning `id/ownerId/mode/state/members`.
- **`DomainError::NotFound` mapped to 409** — `game_events` for a missing account and `bind_local_session` for a missing account returned `CONFLICT` (409) instead of 404. Now maps to `RouteError::NotFound`.

## Changes

- `server/src/domain.rs` — `DomainEvent` + `push_event` ledger; `list_rooms`; events wired into register/login/room/battle/shop paths.
- `server/src/http.rs` — `GET /rooms` route; `NotFound` → 404.
- `server/tests/domain_http.rs` — updated `game_event_polling_requires_a_valid_session` for the event feed + incremental `after` cursor; added `list_rooms_returns_created_rooms_for_member`.
- `server/README.md` — document `GET /rooms` and the event feed.

## Validation

- `cargo fmt --check` — clean.
- `cargo test` — 26/26 pass (run in a temp copy because the live server locks `wzry-local-server.exe`).

## Remaining gaps for live acceptance (not client-provable yet)

- `GameEvents.room`/`messages` fields are still `null`/`[]` — no real client evidence justifies populating them; left empty pending protocol capture.
- `POST /game` `methodId` handlers stay `501` — correct per the no-guessing rule until the capture matrix proves real method IDs.
- The domain event ledger is a *local debug feed*, not the real game's protocol; it only proves the server's polling path works end-to-end for a bound session.
- Persistence is in-memory — a server restart wipes accounts/rooms/orders. Fine for a debug loop; flag for later if live acceptance needs restarts mid-flow.
