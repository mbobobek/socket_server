# Korean Quiz Socket Server

Minimal socket.io backend for live quiz / Kahoot-like flow.

## Run locally
```bash
cd korean_api/socket-server
npm install
npm run dev
```
Server listens on `PORT` (default 3000).

## Socket events
- `session:create` -> `{ pin, sessionId }`
- `session:start` payload: `{ pin, questions: [{ id?, prompt, options, answer, durationMs? }] }`
- `question:next` payload: `{ pin }` -> emits `question`
- `join` payload: `{ pin, name }`
- `answer` payload: `{ pin, answer }`
- Broadcasts: `player:joined`, `question`, `leaderboard`, `session:end`

## Quick client example (host)
```js
import { io } from "socket.io-client";
const socket = io("http://localhost:3000");
socket.emit("session:create", null, ({ pin }) => {
  console.log("PIN:", pin);
  socket.emit("session:start", {
    pin,
    questions: [
      { prompt: "안녕?", options: ["Hello", "Bye"], answer: "Hello", durationMs: 15000 }
    ]
  });
  socket.emit("question:next", { pin });
});
```

## Quick client example (participant)
```js
import { io } from "socket.io-client";
const socket = io("http://localhost:3000");
socket.emit("join", { pin: "123456", name: "Player1" });
socket.on("question", (q) => {
  socket.emit("answer", { pin: "123456", answer: q.options[0] }, (res) => {
    console.log("answer result", res);
  });
});
```

## Deployment (Railway)
- Set root to `korean_api/socket-server`, `npm install`, start command `npm run start`.
- Use public URL in frontend: `io("https://<railway-app>.up.railway.app", { transports: ["websocket"] })`.
