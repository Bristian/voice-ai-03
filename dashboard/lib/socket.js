"use client";

import { io } from "socket.io-client";

let socket = null;

export function getSocket() {
  if (socket) return socket;

  const url = process.env.NEXT_PUBLIC_ECHOKIT_URL || "http://localhost:3000";
  socket = io(url, {
    path: "/supervisor",
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 1000,
  });

  socket.on("connect", () => {
    console.log("[Dashboard] Connected to supervisor socket:", socket.id);
  });

  socket.on("disconnect", (reason) => {
    console.log("[Dashboard] Disconnected:", reason);
  });

  socket.on("connect_error", (err) => {
    console.warn("[Dashboard] Connection error:", err.message);
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
