# Media and Realtime Transport Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make household media private and revocable, and make realtime cooking voice work through Compose/nginx without placing long-lived credentials in URLs or logs.

**Architecture:** Media objects remain stored under opaque MinIO object keys, but the bucket is forced private and clients receive five-minute signed capability URLs that address a database-backed media ID plus an allowed variant. Realtime voice session creation returns a 45-second, one-use ticket bound to the user, family, and session; the browser sends it in `Sec-WebSocket-Protocol`, while nginx upgrades the connection and logs only `$uri`. Backend route tests cover authorization and ticket semantics, while a containerized browser smoke proves that the production nginx template carries a WebSocket handshake and an audio event frame.

**Tech Stack:** FastAPI, SQLAlchemy 2, python-jose, MinIO Python SDK, React 18, TypeScript, Vitest, nginx 1.27, Docker Compose, Playwright

**Execution note (2026-08-23):** The implementation and verification were completed in `codex/media-voice-security-hardening`. Commit steps in this plan were intentionally not executed because this repository requires explicit user authorization before committing.

## Global Constraints

- The MinIO media bucket must not allow anonymous `s3:GetObject`.
- Media access URLs expire after 300 seconds and are revoked immediately when the `MediaAsset` row is deleted.
- A family can only issue access URLs for a `MediaAsset` selected with its current membership `family_id`.
- Realtime WebSocket tickets expire after 45 seconds, are single-use, and are bound to one user, family, and voice session.
- Access tokens and realtime tickets must never appear in a WebSocket URL or nginx access-log request target.
- Browser acceptance must traverse the frontend nginx container and exchange an audio event frame over a real WebSocket.
- Existing business records keep their internal `url`, `file_path`, and variant metadata; no database migration is required.
- No UI or CSS changes are in scope.

---

## File Structure

- Create `backend/app/services/access_tickets.py`: typed creation and validation for media capabilities and realtime WebSocket tickets.
- Modify `backend/app/core/config.py`: bounded TTL settings for media URLs and realtime tickets.
- Modify `backend/app/services/media.py`: enforce a private bucket and read only a selected asset/variant object.
- Modify `backend/app/services/serializers.py`: replace persisted object-key URLs with signed media-ID URLs at the API boundary.
- Modify `backend/app/api/media.py`: remove the raw object-key route; add authenticated access refresh and signed content routes.
- Modify `backend/app/services/ai_audio/realtime.py`: store and atomically consume the one allowed connection-ticket ID.
- Modify `backend/app/services/ai_audio/service.py`: mint a ticket when a registered cooking voice session is created.
- Modify `backend/app/schemas/ai_audio.py` and `backend/app/services/ai_audio/schemas.py`: expose ticket and ticket expiry in the stable session response.
- Modify `backend/app/api/ai_audio.py`: authenticate the WebSocket from subprotocol ticket claims instead of an access-token query parameter.
- Modify `frontend/src/api/aiVoiceApi.ts`: model the ticket response and build URL/protocol values without reading the access token.
- Modify `frontend/src/components/recipes/useCookingRealtimeVoiceSession.ts`: construct the WebSocket with the ticket subprotocols.
- Modify `frontend/nginx.conf`: add upgrade headers/timeouts, remove direct MinIO proxying, and use a query-free access log.
- Modify `deploy/docker-compose.yml`, `deploy/.env.example`, and `deploy/README.md`: expose/document safe TTL defaults and the private media path.
- Create `docs/security/media-access.md`: document the capability URL privacy model, expiry, revocation, and residual leak window.
- Create `backend/tests/deployment/websocket_echo_server.py`: deployment-only WebSocket peer for the nginx transport smoke.
- Create `deploy/tests/docker-compose.websocket-smoke.yml`: isolated nginx/backend smoke topology.
- Create `frontend/playwright.deployment.config.mjs` and `frontend/e2e/realtime-websocket-deployment.spec.mjs`: browser handshake/audio-frame acceptance.
- Create `deploy/tests/run-realtime-websocket-smoke.mjs`: bring the isolated topology up, run Playwright, and always tear it down.
- Modify `package.json`: expose `npm run deploy:smoke:realtime`.

### Task 1: Typed short-lived access tickets and bounded configuration

**Files:**
- Create: `backend/app/services/access_tickets.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/tests/core/test_config.py`
- Create: `backend/tests/core/test_access_tickets.py`
- Modify: `deploy/docker-compose.yml`
- Modify: `deploy/.env.example`

**Interfaces:**
- Produces: `create_media_access_ticket(media_id: str, family_id: str, variant: MediaVariantName) -> EncodedTicket`
- Produces: `decode_media_access_ticket(token: str) -> MediaAccessClaims`
- Produces: `create_realtime_websocket_ticket(session_id: str, family_id: str, user_id: str) -> EncodedTicket`
- Produces: `decode_realtime_websocket_ticket(token: str) -> RealtimeTicketClaims`
- Produces: `EncodedTicket(token: str, expires_at: datetime, ticket_id: str)`
- Consumes: `Settings.jwt_secret`, `Settings.media_access_url_ttl_seconds`, and `Settings.realtime_websocket_ticket_ttl_seconds`

- [ ] **Step 1: Write failing TTL and claim-isolation tests**

```python
def test_security_ticket_defaults_are_short_lived() -> None:
    settings = Settings(_env_file=None)
    assert settings.media_access_url_ttl_seconds == 300
    assert settings.realtime_websocket_ticket_ttl_seconds == 45


def test_media_ticket_rejects_realtime_decoder() -> None:
    ticket = create_media_access_ticket(
        media_id="photo-a", family_id="family-a", variant="card"
    )
    with pytest.raises(AccessTicketInvalid):
        decode_realtime_websocket_ticket(ticket.token)


def test_realtime_ticket_is_bound_to_user_family_and_session() -> None:
    encoded = create_realtime_websocket_ticket(
        session_id="voice-a", family_id="family-a", user_id="user-a"
    )
    claims = decode_realtime_websocket_ticket(encoded.token)
    assert (claims.session_id, claims.family_id, claims.user_id) == (
        "voice-a", "family-a", "user-a"
    )
    assert claims.ticket_id == encoded.ticket_id
```

- [ ] **Step 2: Run the focused tests and confirm missing settings/module failures**

Run: `backend/.venv/bin/python -m pytest backend/tests/core/test_config.py backend/tests/core/test_access_tickets.py -q`

Expected: FAIL because `access_tickets.py` and the two TTL settings do not exist.

- [ ] **Step 3: Implement strict ticket types and TTL validation**

```python
MEDIA_ACCESS_AUDIENCE = "culina-media-access"
REALTIME_WEBSOCKET_AUDIENCE = "culina-realtime-websocket"


@dataclass(frozen=True, slots=True)
class EncodedTicket:
    token: str
    expires_at: datetime
    ticket_id: str


def create_realtime_websocket_ticket(*, session_id: str, family_id: str, user_id: str) -> EncodedTicket:
    settings = get_settings()
    issued_at = utcnow()
    expires_at = issued_at + timedelta(seconds=settings.realtime_websocket_ticket_ttl_seconds)
    ticket_id = f"voice_ticket-{uuid4().hex}"
    token = jwt.encode(
        {
            "aud": REALTIME_WEBSOCKET_AUDIENCE,
            "typ": "realtime_websocket",
            "sub": user_id,
            "family_id": family_id,
            "session_id": session_id,
            "jti": ticket_id,
            "iat": issued_at,
            "exp": expires_at,
        },
        settings.jwt_secret,
        algorithm="HS256",
    )
    return EncodedTicket(token=token, expires_at=expires_at, ticket_id=ticket_id)
```

Add `media_access_url_ttl_seconds: int = 300` and `realtime_websocket_ticket_ttl_seconds: int = 45` to `Settings`. Reject media TTLs outside 30–900 seconds and realtime TTLs outside 30–60 seconds in `validate_safe_runtime_settings`. Decode with the exact expected audience, `typ`, non-empty scoped IDs, and `jti`; translate every `JWTError` or malformed claim into `AccessTicketInvalid` without returning raw token details.

- [ ] **Step 4: Wire exact Compose defaults**

```yaml
MEDIA_ACCESS_URL_TTL_SECONDS: ${MEDIA_ACCESS_URL_TTL_SECONDS:-300}
REALTIME_WEBSOCKET_TICKET_TTL_SECONDS: ${REALTIME_WEBSOCKET_TICKET_TTL_SECONDS:-45}
```

Add matching values and Chinese comments to `deploy/.env.example`.

- [ ] **Step 5: Run focused tests**

Run: `backend/.venv/bin/python -m pytest backend/tests/core/test_config.py backend/tests/core/test_access_tickets.py -q`

Expected: PASS.

- [ ] **Step 6: Commit the ticket foundation**

```bash
git add backend/app/core/config.py backend/app/services/access_tickets.py backend/tests/core/test_config.py backend/tests/core/test_access_tickets.py deploy/docker-compose.yml deploy/.env.example
git commit -m "security: add scoped short-lived access tickets"
```

### Task 2: Private MinIO media and revocable media-ID access

**Files:**
- Modify: `backend/app/services/media.py`
- Modify: `backend/app/services/serializers.py`
- Modify: `backend/app/api/media.py`
- Modify: `backend/tests/media/test_media_security.py`
- Modify: `frontend/src/lib/assets.test.ts`
- Create: `docs/security/media-access.md`

**Interfaces:**
- Consumes: `create_media_access_ticket(...)` and `decode_media_access_ticket(...)` from Task 1.
- Produces: `signed_media_content_url(asset: MediaAsset, variant: MediaVariantName) -> str`
- Produces: `read_media_asset_content(asset: MediaAsset, variant: MediaVariantName) -> tuple[bytes, str]`
- Produces: `GET /api/media/{media_id}/access` (Bearer-authenticated `MediaAssetOut` refresh)
- Produces: `GET /api/media/{media_id}/content?variant=<name>&ticket=<short-lived>` (capability read)

- [ ] **Step 1: Replace the public-route test with four failing security cases**

```python
def test_media_content_without_capability_is_unauthorized(self) -> None:
    response = self.client.get("/api/media/photo-private/content?variant=original")
    self.assertEqual(response.status_code, 401)


def test_other_family_cannot_issue_media_access(self) -> None:
    response = self.other_family_client.get("/api/media/photo-private/access")
    self.assertEqual(response.status_code, 404)


def test_expired_media_capability_is_unauthorized(self) -> None:
    expired = create_media_access_ticket(
        media_id="photo-private",
        family_id="family-test",
        variant="original",
        expires_at=utcnow() - timedelta(seconds=1),
    )
    response = self.client.get(
        f"/api/media/photo-private/content?variant=original&ticket={expired.token}"
    )
    self.assertEqual(response.status_code, 401)


def test_deleted_media_is_not_readable_with_unexpired_capability(self) -> None:
    access = self.client.get("/api/media/photo-private/access").json()
    delete_media_row("photo-private")
    response = self.client.get(access["url"])
    self.assertEqual(response.status_code, 404)
```

Also assert `ensure_media_bucket()` calls `delete_bucket_policy` and never `set_bucket_policy`, and assert a signed URL contains `/api/media/photo-private/content` without the raw `family-test/private.png` object key.

- [ ] **Step 2: Run media tests and confirm the insecure behavior**

Run: `backend/.venv/bin/python -m pytest backend/tests/media/test_media_security.py -q`

Expected: FAIL because the bucket is made public, `/media/{object_key}` is unauthenticated, and signed media-ID endpoints do not exist.

- [ ] **Step 3: Force the bucket private and read only known asset variants**

```python
def ensure_media_bucket() -> None:
    settings = get_settings()
    client = _storage_client()
    if not client.bucket_exists(settings.minio_bucket):
        client.make_bucket(settings.minio_bucket)
    try:
        client.delete_bucket_policy(settings.minio_bucket)
    except S3Error as exc:
        if exc.code != "NoSuchBucketPolicy":
            raise


def read_media_asset_content(asset: MediaAsset, variant: MediaVariantName) -> tuple[bytes, str]:
    object_key = asset.file_path if variant == "original" else _variant_object_key_from_asset(asset, variant)
    return _read_object_by_key(object_key)
```

Do not retain the old suffix-search fallback: every public read must start from a database-selected `MediaAsset`, and variants are limited to `thumb`, `card`, or `large` metadata already stored on that asset.

- [ ] **Step 4: Sign API-bound media URLs and add access/content routes**

```python
def serialize_media(asset: MediaAsset) -> dict:
    return {
        "id": asset.id,
        "name": asset.name,
        "url": signed_media_content_url(asset, "original"),
        "source": asset.source,
        "alt": asset.alt,
        "generation_mode": asset.generation_mode,
        "reference_media_id": asset.reference_media_id,
        "style_key": asset.style_key,
        "prompt_version": asset.prompt_version,
        "variants": signed_media_variants(asset),
        "created_at": _utc_datetime(asset.created_at),
        "created_by": asset.created_by,
    }
```

The authenticated refresh route selects with both `MediaAsset.id == media_id` and `MediaAsset.family_id == membership.family_id`. The content route rejects missing, invalid, expired, wrong-media, or wrong-variant tickets with 401; then selects the row with both ticket `media_id` and ticket `family_id`, returning 404 after deletion. Return `Cache-Control: private, max-age=<remaining ticket seconds>` and `X-Content-Type-Options: nosniff`.

- [ ] **Step 5: Update frontend helper fixtures to signed API paths**

```ts
const signedOriginal = '/api/media/photo-1/content?variant=original&ticket=media-ticket';
const signedCard = '/api/media/photo-1/content?variant=card&ticket=media-ticket';

expect(resolveMediaUrl(mediaAsset({ url: signedOriginal }), 'original'))
  .toBe(`${API_BASE_URL}${signedOriginal}`);
```

No runtime `assets.ts` change is expected; this test proves the existing centralized resolver accepts the new relative signed URL contract.

- [ ] **Step 6: Document the privacy model**

Write `docs/security/media-access.md` with these exact properties: the bucket is private; API responses issue five-minute capability URLs; anyone holding a still-valid URL can read only that media ID/variant; membership is checked at issuance; signature/expiry/media binding is checked at read; deleting the row immediately revokes the URL; expiry limits a leaked URL's residual window; nginx and backend must not log query strings; persisted object keys are never public identifiers.

- [ ] **Step 7: Run backend and frontend media tests**

Run: `backend/.venv/bin/python -m pytest backend/tests/media -q`

Run: `npm --prefix frontend run test -- src/lib/assets.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit private media access**

```bash
git add backend/app/services/media.py backend/app/services/serializers.py backend/app/api/media.py backend/tests/media/test_media_security.py frontend/src/lib/assets.test.ts docs/security/media-access.md
git commit -m "security: protect household media with expiring access URLs"
```

### Task 3: One-use realtime tickets and browser subprotocol authentication

**Files:**
- Modify: `backend/app/services/ai_audio/realtime.py`
- Modify: `backend/app/services/ai_audio/service.py`
- Modify: `backend/app/services/ai_audio/schemas.py`
- Modify: `backend/app/schemas/ai_audio.py`
- Modify: `backend/app/api/ai_audio.py`
- Modify: `backend/tests/ai_audio/test_ai_audio_api.py`
- Modify: `backend/tests/ai_audio/test_ai_audio_service.py`
- Modify: `frontend/src/api/aiVoiceApi.ts`
- Create: `frontend/src/api/aiVoiceApi.test.ts`
- Modify: `frontend/src/components/recipes/useCookingRealtimeVoiceSession.ts`
- Modify: `frontend/src/components/recipes/useCookingRealtimeVoiceSession.test.tsx`

**Interfaces:**
- Consumes: realtime ticket helpers from Task 1.
- Produces: response fields `websocket_ticket: string` and `websocket_ticket_expires_at: str`.
- Produces: `RealtimeVoiceSessionStore.consume_connection_ticket(session_id, family_id, user_id, ticket_id) -> RealtimeVoiceSessionState`.
- Produces: `cookingRealtimeWebSocketProtocols(ticket: string) -> ["culina-realtime", "culina-ticket.<ticket>"]`.

- [ ] **Step 1: Write failing backend contract and replay tests**

```python
def test_member_realtime_response_contains_only_short_lived_connection_ticket() -> None:
    response = CookingRealtimeSessionResponse(
        session_id="voice-a",
        websocket_url="/api/ai/realtime/cooking/sessions/voice-a/ws",
        websocket_ticket="short-ticket",
        websocket_ticket_expires_at="2026-08-23T00:00:45+00:00",
        expires_at="2026-08-23T00:05:00+00:00",
    ).model_dump()
    assert response["websocket_ticket"] == "short-ticket"
    assert "token" not in response["websocket_url"]


def test_realtime_connection_ticket_can_only_be_consumed_once() -> None:
    store.put(state_with_ticket("ticket-a"))
    assert store.consume_connection_ticket(
        "voice-a", family_id="family-a", user_id="user-a", ticket_id="ticket-a"
    ).session_id == "voice-a"
    with pytest.raises(HTTPException) as exc_info:
        store.consume_connection_ticket(
            "voice-a", family_id="family-a", user_id="user-a", ticket_id="ticket-a"
        )
    assert exc_info.value.status_code == 401
```

Add WebSocket tests for missing ticket (4401), expired ticket (4401), wrong family/user/session (4403/4404 without revealing which claim failed), and the same ticket replayed after a successful handshake (4401).

- [ ] **Step 2: Run backend audio tests and verify failures**

Run: `backend/.venv/bin/python -m pytest backend/tests/ai_audio -q`

Expected: FAIL because the session store and response do not carry a connection ticket and the route still accepts `?token=<access JWT>`.

- [ ] **Step 3: Mint and atomically consume one connection ticket**

```python
@dataclass(slots=True)
class RealtimeVoiceSessionState:
    # existing fields...
    connection_ticket_id: str = ""
    connection_ticket_consumed: bool = False


def consume_connection_ticket(self, session_id: str, *, family_id: str, user_id: str, ticket_id: str) -> RealtimeVoiceSessionState:
    with self._lock:
        state = self._get_locked(session_id)
        if state.family_id != family_id or state.user_id != user_id:
            raise HTTPException(status_code=403, detail="Voice session is not available")
        if not ticket_id or ticket_id != state.connection_ticket_id or state.connection_ticket_consumed:
            raise HTTPException(status_code=401, detail="Voice connection ticket is invalid")
        state.connection_ticket_consumed = True
        return state
```

`AIAudioService.create_cooking_session` creates the ticket after the session ID exists, stores its `ticket_id` on the registered state, and returns the token plus the ticket expiry separately from the five-minute voice-session expiry.

- [ ] **Step 4: Authenticate the WebSocket from `Sec-WebSocket-Protocol`**

```python
REALTIME_SUBPROTOCOL = "culina-realtime"
TICKET_SUBPROTOCOL_PREFIX = "culina-ticket."


def _websocket_ticket(websocket: WebSocket) -> str | None:
    offered = [item.strip() for item in websocket.headers.get("sec-websocket-protocol", "").split(",")]
    ticket_protocol = next((item for item in offered if item.startswith(TICKET_SUBPROTOCOL_PREFIX)), None)
    return ticket_protocol.removeprefix(TICKET_SUBPROTOCOL_PREFIX) if ticket_protocol else None
```

Decode the ticket, re-read the active user and membership, require exact user/family claims, then atomically consume it before resolving the provider. Remove the `Query` parameter and `_authenticate_websocket_token`. Accept successful connections with `await websocket.accept(subprotocol=REALTIME_SUBPROTOCOL)` so only the public protocol name is echoed.

- [ ] **Step 5: Write failing frontend URL/protocol tests**

```ts
it('never puts the access token or realtime ticket in the websocket URL', () => {
  setAccessToken('seven-day-access-token');
  const url = cookingRealtimeWebSocketUrl('/api/ai/realtime/cooking/sessions/voice-a/ws');
  expect(url).not.toContain('seven-day-access-token');
  expect(new URL(url).search).toBe('');
});

it('sends the short-lived ticket as a non-echoed websocket subprotocol offer', () => {
  expect(cookingRealtimeWebSocketProtocols('ticket-a')).toEqual([
    'culina-realtime',
    'culina-ticket.ticket-a',
  ]);
});
```

- [ ] **Step 6: Update the frontend session contract and WebSocket construction**

```ts
export type CookingRealtimeSessionResponse = {
  mode: 'agent_backed_websocket';
  session_id: string;
  websocket_url: string;
  websocket_ticket: string;
  websocket_ticket_expires_at: string;
  expires_at: string;
};

const socket = new WebSocket(
  aiVoiceApi.cookingRealtimeWebSocketUrl(nextSession.websocket_url),
  aiVoiceApi.cookingRealtimeWebSocketProtocols(nextSession.websocket_ticket),
);
```

Update `FakeWebSocket` to record its `protocols` constructor argument and assert the hook passes only the short-lived ticket protocols.

- [ ] **Step 7: Run backend and frontend voice tests**

Run: `backend/.venv/bin/python -m pytest backend/tests/ai_audio -q`

Run: `npm --prefix frontend run test -- src/api/aiVoiceApi.test.ts src/components/recipes/useCookingRealtimeVoiceSession.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit realtime ticket authentication**

```bash
git add backend/app/services/ai_audio/realtime.py backend/app/services/ai_audio/service.py backend/app/services/ai_audio/schemas.py backend/app/schemas/ai_audio.py backend/app/api/ai_audio.py backend/tests/ai_audio frontend/src/api/aiVoiceApi.ts frontend/src/api/aiVoiceApi.test.ts frontend/src/components/recipes/useCookingRealtimeVoiceSession.ts frontend/src/components/recipes/useCookingRealtimeVoiceSession.test.tsx
git commit -m "security: replace websocket access tokens with one-use tickets"
```

### Task 4: nginx WebSocket transport and query-free logging

**Files:**
- Modify: `frontend/nginx.conf`
- Modify: `deploy/README.md`
- Create: `backend/tests/deployment/test_nginx_security.py`

**Interfaces:**
- Consumes: `/api/ai/realtime/.../ws` and signed `/api/media/.../content` routes from Tasks 2–3.
- Produces: nginx `$connection_upgrade` mapping and `culina_access` log format that uses `$uri`, never `$request` or `$request_uri`.

- [ ] **Step 1: Write a failing static deployment-policy test**

```python
def test_nginx_proxies_websockets_without_logging_queries() -> None:
    config = Path("../frontend/nginx.conf").read_text()
    assert "proxy_set_header Upgrade $http_upgrade;" in config
    assert "proxy_set_header Connection $connection_upgrade;" in config
    assert "proxy_read_timeout 360s;" in config
    assert "proxy_send_timeout 360s;" in config
    assert "log_format culina_access" in config
    assert '"$request_method $uri $server_protocol"' in config
    assert "$request_uri" not in config
    assert "location /media/" not in config
    assert "proxy_pass http://minio" not in config
```

- [ ] **Step 2: Run the static test and verify the current config fails**

Run: `cd backend && .venv/bin/python -m pytest tests/deployment/test_nginx_security.py -q`

Expected: FAIL on missing upgrade headers/timeouts, default request logging, and direct MinIO proxying.

- [ ] **Step 3: Harden nginx**

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

log_format culina_access '$remote_addr - $remote_user [$time_local] '
                         '"$request_method $uri $server_protocol" $status $body_bytes_sent '
                         '"$http_referer" "$http_user_agent"';

server {
    access_log /var/log/nginx/access.log culina_access;

    location /api/ {
        proxy_pass http://backend:8010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 360s;
        proxy_send_timeout 360s;
        # existing forwarded headers remain
    }
}
```

Delete the entire `/media/` MinIO location. Update `deploy/README.md` to state all media bytes now flow through signed `/api/media/{id}/content` URLs and the bucket remains private.

- [ ] **Step 4: Run the static deployment test**

Run: `cd backend && .venv/bin/python -m pytest tests/deployment/test_nginx_security.py -q`

Expected: PASS.

- [ ] **Step 5: Commit nginx hardening**

```bash
git add frontend/nginx.conf deploy/README.md backend/tests/deployment/test_nginx_security.py
git commit -m "security: harden nginx websocket and media proxying"
```

### Task 5: Browser-through-nginx deployment smoke with an audio frame

**Files:**
- Create: `backend/tests/deployment/websocket_echo_server.py`
- Create: `deploy/tests/docker-compose.websocket-smoke.yml`
- Create: `frontend/playwright.deployment.config.mjs`
- Create: `frontend/e2e/realtime-websocket-deployment.spec.mjs`
- Create: `deploy/tests/run-realtime-websocket-smoke.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run deploy:smoke:realtime`.
- The smoke backend exposes `/api/health` and the exact cooking realtime WebSocket path; it is test-only and is never imported by `app.main`.
- The browser connects through the built frontend nginx image, offers `culina-realtime` plus `culina-ticket.smoke-ticket`, sends a base64 PCM `audio` event, and receives an `audio_ack` containing the decoded byte length.

- [ ] **Step 1: Add the deployment-only WebSocket peer**

```python
@app.websocket("/api/ai/realtime/cooking/sessions/{session_id}/ws")
async def websocket_smoke(websocket: WebSocket, session_id: str) -> None:
    protocols = [value.strip() for value in websocket.headers.get("sec-websocket-protocol", "").split(",")]
    if "culina-realtime" not in protocols or "culina-ticket.smoke-ticket" not in protocols:
        await websocket.close(code=4401)
        return
    await websocket.accept(subprotocol="culina-realtime")
    event = await websocket.receive_json()
    audio = base64.b64decode(event["data"], validate=True)
    await websocket.send_json(
        {"type": "audio_ack", "session_id": session_id, "byte_length": len(audio)}
    )
    await websocket.close(code=1000)
```

- [ ] **Step 2: Add an isolated Compose topology using the production nginx image**

```yaml
name: culina-realtime-websocket-smoke
services:
  backend:
    build:
      context: ../..
      dockerfile: backend/Dockerfile
    command: ["uvicorn", "tests.deployment.websocket_echo_server:app", "--host", "0.0.0.0", "--port", "8010"]
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/api/health').read()\""]
  frontend:
    build:
      context: ../..
      dockerfile: frontend/Dockerfile
    ports:
      - "${CULINA_WS_SMOKE_PORT:-18080}:80"
    depends_on:
      backend:
        condition: service_healthy
```

- [ ] **Step 3: Write the Playwright browser acceptance**

```javascript
test('browser crosses nginx and exchanges an audio event frame', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const socket = new WebSocket(
      `${location.origin.replace(/^http/, 'ws')}/api/ai/realtime/cooking/sessions/smoke-session/ws`,
      ['culina-realtime', 'culina-ticket.smoke-ticket'],
    );
    return await new Promise((resolve, reject) => {
      socket.onopen = () => socket.send(JSON.stringify({
        type: 'audio', mime_type: 'audio/pcm', data: btoa('pcm-audio-frame'),
      }));
      socket.onmessage = (event) => resolve({ protocol: socket.protocol, payload: JSON.parse(event.data) });
      socket.onerror = () => reject(new Error('websocket failed'));
    });
  });
  expect(result.protocol).toBe('culina-realtime');
  expect(result.payload).toMatchObject({ type: 'audio_ack', byte_length: 15 });
});
```

- [ ] **Step 4: Add a teardown-safe runner and root command**

`run-realtime-websocket-smoke.mjs` must call `docker compose up -d --build --wait`, run Playwright with `CULINA_DEPLOYMENT_BASE_URL=http://127.0.0.1:18080`, then call `docker compose down --remove-orphans` in `finally`, preserving the Playwright exit code. Add:

```json
"deploy:smoke:realtime": "node deploy/tests/run-realtime-websocket-smoke.mjs"
```

- [ ] **Step 5: Run the real browser/nginx smoke**

Run: `npm run deploy:smoke:realtime`

Expected: one Playwright test passes; the browser reports `culina-realtime` and `audio_ack`; temporary smoke containers are removed.

- [ ] **Step 6: Commit deployment acceptance**

```bash
git add backend/tests/deployment/websocket_echo_server.py deploy/tests/docker-compose.websocket-smoke.yml frontend/playwright.deployment.config.mjs frontend/e2e/realtime-websocket-deployment.spec.mjs deploy/tests/run-realtime-websocket-smoke.mjs package.json
git commit -m "test: cover realtime websocket through production nginx"
```

### Task 6: Full regression and security verification

**Files:**
- Verify all files modified in Tasks 1–5.

**Interfaces:**
- Consumes every earlier task.
- Produces fresh evidence for backend correctness, frontend contracts/build, nginx deployment transport, and clean diffs.

- [ ] **Step 1: Run all backend media, audio, core, and deployment tests**

Run: `cd backend && .venv/bin/python -m pytest tests/core tests/media tests/ai_audio tests/deployment -q`

Expected: PASS with 0 failures.

- [ ] **Step 2: Run the backend service suite**

Run: `npm run backend:test:service`

Expected: PASS with 0 failures.

- [ ] **Step 3: Run frontend quality and production build**

Run: `npm run frontend:quality`

Run: `npm run frontend:build`

Expected: typecheck, Vitest, style-token report, Vite build, and bundle budgets all pass. Because no CSS changes are made, the style-token report must have no new hits attributable to this task.

- [ ] **Step 4: Re-run the browser/nginx audio-frame smoke**

Run: `npm run deploy:smoke:realtime`

Expected: PASS at the Playwright config's desktop Chromium viewport (1280×720) through the frontend nginx container.

- [ ] **Step 5: Inspect for leaked credentials, public routes, and malformed diffs**

Run: `rg -n "searchParams\.set\(['\"]token|[?&]token=|proxy_pass http://minio|set_bucket_policy|\$request_uri" backend frontend deploy --glob '!**/node_modules/**'`

Expected: no production-code matches; test assertions may name forbidden patterns.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 6: Review worktree state**

Run: `git status --short --branch`

Expected: branch `codex/media-voice-security-hardening`; only the planned files differ from the worktree base.

## Self-Review

- Spec coverage: bucket privacy, removal of raw media proxying, family-scoped issuance, expiry, deletion revocation, unauthenticated/cross-family/expired/deleted tests, nginx Upgrade/Connection/timeouts, short one-use ticket, no access token in URL, query-free logs, and browser nginx audio-frame acceptance each map to Tasks 1–5.
- Placeholder scan: every implementation and verification step names concrete files, interfaces, commands, expected results, and failure behavior; no reserved placeholder markers remain.
- Type consistency: `EncodedTicket.ticket_id` maps to `RealtimeVoiceSessionState.connection_ticket_id`; `websocket_ticket` and `websocket_ticket_expires_at` match in service schema, API schema, frontend type, hook, and tests; media variants use the single `MediaVariantName` union.
- Scope control: no model migration, UI/CSS change, provider protocol change, or access-token lifetime change is included.
