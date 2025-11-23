import express from "express";
import http from "http";
import { Server } from "socket.io";
import { v4 as uuid } from "uuid";

// Runtime config
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const IS_DEV = process.env.NODE_ENV === "development";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] }
});

// In-memory session store; restart-safe persistence is out of scope for this lightweight service.
const SESSIONS = new Map(); // pin -> session

// Scoring constants
const BASE_SCORE = 1000;
const TIME_BONUS_MAX = 500; // max bonus for answering immediately
const STREAK_STEP = 100; // each consecutive correct adds this much bonus; missed answer removes it

function log(...args) {
  if (IS_DEV) console.log("[socket-server]", ...args);
}

function genPin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function createSession(hostSocketId) {
  let pin = genPin();
  while (SESSIONS.has(pin)) pin = genPin();
  const session = {
    id: uuid(),
    pin,
    hostSocketId,
    players: new Map(), // socketId -> player
    questions: [],
    questionIdx: -1,
    deadline: null,
    timer: null
  };
  SESSIONS.set(pin, session);
  return session;
}

function addPlayer(session, socket, name) {
  const player = {
    id: uuid(),
    socketId: socket.id,
    name: (name || "Guest").toString().slice(0, 40),
    score: 0,
    lastAnswer: null,
    streak: 0
  };
  session.players.set(socket.id, player);
  return player;
}

function currentQuestion(session) {
  return session.questions[session.questionIdx] || null;
}

function scoreAnswer(session, player, payload) {
  const q = currentQuestion(session);
  if (!q) return { ok: false, reason: "no-question" };
  if (player.lastAnswer && player.lastAnswer.qid === q.id) return { ok: false, reason: "already-answered" };
  const now = Date.now();
  if (!session.deadline || now > session.deadline) return { ok: false, reason: "too-late" };

  const isCorrect = payload.answer === q.answer;
  const remainingMs = Math.max(0, session.deadline - now);
  const timeBonus = Math.floor((remainingMs / q.durationMs) * TIME_BONUS_MAX);

  // Streak bonus/penalty: consecutive correct answers build up, miss removes streak value
  let streakBonus = 0;
  let penalty = 0;
  if (isCorrect) {
    player.streak = (player.streak || 0) + 1;
    streakBonus = player.streak * STREAK_STEP;
    const gained = BASE_SCORE + timeBonus + streakBonus;
    player.score += gained;
    player.lastAnswer = { qid: q.id, correct: true, gained, timeBonus, streakBonus, penalty: 0 };
    return { ok: true, isCorrect, gained, correct: q.answer, streak: player.streak };
  }

  // Incorrect: remove accumulated streak bonus (symmetry)
  penalty = (player.streak || 0) * STREAK_STEP;
  player.score = Math.max(0, player.score - penalty);
  player.streak = 0;
  player.lastAnswer = { qid: q.id, correct: false, gained: 0, timeBonus: 0, streakBonus: 0, penalty };
  return { ok: true, isCorrect, gained: 0, penalty, correct: q.answer, streak: player.streak };
}

function emitLeaderboard(session) {
  const data = Array.from(session.players.values())
    .map(({ id, name, score, lastAnswer }) => ({ id, name, score, lastAnswer }))
    .sort((a, b) => b.score - a.score);
  io.to(session.pin).emit("leaderboard", data);
}

function endSession(session, reason) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  io.to(session.pin).emit("session:end", { reason });
}

function nextQuestion(session) {
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  session.questionIdx += 1;
  const q = currentQuestion(session);
  if (!q) {
    endSession(session, "done");
    return { ok: false, reason: "no-more" };
  }
  session.deadline = Date.now() + q.durationMs;
  io.to(session.pin).emit("question", {
    id: q.id,
    prompt: q.prompt,
    options: q.options,
    deadline: session.deadline,
    idx: session.questionIdx,
    total: session.questions.length
  });
  // Safety: auto-advance when deadline hits even if no answers arrive.
  session.timer = setTimeout(() => nextQuestion(session), q.durationMs + 50);
  return { ok: true };
}

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on("session:create", (_, cb) => {
    const session = createSession(socket.id);
    socket.join(session.pin);
    cb?.({ pin: session.pin, sessionId: session.id });
    log("session:create", session.pin);
  });

  socket.on("session:start", ({ pin, questions }, cb) => {
    const session = SESSIONS.get(pin);
    if (!session || session.hostSocketId !== socket.id) return cb?.({ ok: false, reason: "not-host" });
    session.questions = (questions || []).map((q) => ({
      id: q.id || uuid(),
      prompt: q.prompt,
      options: q.options,
      answer: q.answer,
      durationMs: q.durationMs || 15000
    }));
    session.questionIdx = -1;
    cb?.({ ok: true });
    log("session:start", pin, "questions:", session.questions.length);
    nextQuestion(session);
  });

  socket.on("question:next", ({ pin }, cb) => {
    const session = SESSIONS.get(pin);
    if (!session || session.hostSocketId !== socket.id) return cb?.({ ok: false, reason: "not-host" });
    const res = nextQuestion(session);
    cb?.(res);
  });

  socket.on("join", ({ pin, name }, cb) => {
    const session = SESSIONS.get(pin);
    if (!session) return cb?.({ ok: false, reason: "not-found" });
    socket.join(pin);
    const player = addPlayer(session, socket, name || "Guest");
    io.to(pin).emit("player:joined", { id: player.id, name: player.name });
    emitLeaderboard(session);
    cb?.({ ok: true, playerId: player.id, pin });
    log("join", { pin, player: player.name });
  });

  socket.on("answer", ({ pin, answer }, cb) => {
    const session = SESSIONS.get(pin);
    if (!session) return cb?.({ ok: false, reason: "not-found" });
    const player = session.players.get(socket.id);
    if (!player) return cb?.({ ok: false, reason: "not-joined" });
    const res = scoreAnswer(session, player, { answer });
    if (!res.ok) return cb?.(res);
    cb?.({
      ok: true,
      correct: res.isCorrect,
      gained: res.gained,
      penalty: res.penalty || 0,
      right: res.correct,
      streak: res.streak
    });
    log("answer", { pin, player: player.name, correct: res.isCorrect, gained: res.gained, penalty: res.penalty || 0 });
    emitLeaderboard(session);
  });

  socket.on("disconnect", () => {
    // Cleanup player entries
    for (const [pin, session] of SESSIONS.entries()) {
      if (session.hostSocketId === socket.id) {
        endSession(session, "host-left");
        SESSIONS.delete(pin);
        continue;
      }
      if (session.players.has(socket.id)) {
        session.players.delete(socket.id);
        emitLeaderboard(session);
      }
    }
  });
});

app.get("/", (_req, res) => {
  res.send("Korean quiz socket server is running.");
});

server.listen(PORT, () => {
  console.log(`Socket server listening on ${PORT}`);
});
