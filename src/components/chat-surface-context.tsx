"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ChatSurface } from "@/lib/chat-transition";

type ChatSurfaceContextValue = {
  surface: ChatSurface | null;
  setSurface: (surface: ChatSurface | null) => void;
};

const ChatSurfaceContext = createContext<ChatSurfaceContextValue | null>(null);

export function ChatSurfaceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [surface, setSurfaceState] = useState<ChatSurface | null>(null);
  const setSurface = useCallback((next: ChatSurface | null) => setSurfaceState(next), []);
  const value = useMemo(() => ({ surface, setSurface }), [surface, setSurface]);
  return <ChatSurfaceContext.Provider value={value}>{children}</ChatSurfaceContext.Provider>;
}

export function useChatSurface() {
  const value = useContext(ChatSurfaceContext);
  if (!value) throw new Error("useChatSurface must be used inside ChatSurfaceProvider");
  return value;
}
