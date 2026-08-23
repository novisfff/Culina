from __future__ import annotations

import base64

from fastapi import FastAPI, WebSocket

app = FastAPI()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/api/ai/realtime/cooking/sessions/{session_id}/ws")
async def websocket_smoke(websocket: WebSocket, session_id: str) -> None:
    protocols = [
        value.strip()
        for value in websocket.headers.get("sec-websocket-protocol", "").split(",")
    ]
    if (
        "culina-realtime" not in protocols
        or "culina-ticket.smoke-ticket" not in protocols
    ):
        await websocket.close(code=4401)
        return
    await websocket.accept(subprotocol="culina-realtime")
    event = await websocket.receive_json()
    if event.get("type") != "audio_chunk_done":
        await websocket.close(code=4400)
        return
    audio = base64.b64decode(str(event.get("data") or ""), validate=True)
    await websocket.send_json(
        {
            "type": "audio_ack",
            "session_id": session_id,
            "byte_length": len(audio),
        }
    )
    await websocket.close(code=1000)
