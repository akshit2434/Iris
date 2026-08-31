"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { IrisMark } from "@/components/iris-mark";
import { MobileNav } from "@/components/mobile-nav";
import { ProceduralBlur } from "@/components/procedural-blur";
import { ProfileProvider, useProfile } from "@/components/profile-provider";
import { ChatSurfaceProvider, useChatSurface } from "@/components/chat-surface-context";
import { DelayedPagePresence } from "@/components/delayed-page-presence";
import { ChatScreen } from "@/components/chat-screen";
import { canStartChatCreation, createChatExitCoordinator, type ChatExitCoordinator } from "@/lib/chat-transition";
import { isUnsavedChatPath } from "@/lib/chat-route";

const navItems = [
  { href: "/", label: "Home" },
  { href: "/history", label: "History" },
  { href: "/files", label: "Files" },
  { href: "/memory", label: "Memory" },
];

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return <ProfileProvider><ChatSurfaceProvider><ShellContents>{children}</ShellContents></ChatSurfaceProvider></ProfileProvider>;
}

function ShellContents({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const { profileId, profileLabels, isReady, clearProfile } = useProfile();
  const { surface } = useChatSurface();
  const [isCreating, setIsCreating] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const exitCoordinatorRef = useRef<ChatExitCoordinator | null>(null);
  const inChat = pathname.startsWith("/chat/");
  const currentThreadId = inChat ? pathname.slice("/chat/".length).split("/")[0] : null;
  const currentSurface = surface?.threadId === currentThreadId ? surface : null;

  useEffect(() => {
    setIsExiting(false);
    exitCoordinatorRef.current?.cancel();
  }, [pathname]);

  function exitCoordinator() {
    if (!exitCoordinatorRef.current) {
      const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      exitCoordinatorRef.current = createChatExitCoordinator({ reducedMotion });
    }
    return exitCoordinatorRef.current;
  }

  async function createNewChat() {
    if (!profileId) return router.push("/");
    // /chat/new is already the unsaved composer. Keeping this guard before
    // the surface check makes the action a true no-op with no request or exit.
    if (isUnsavedChatPath(pathname)) return;
    if (!canStartChatCreation({ hasProfile: Boolean(profileId), isCreating, isExiting, surface: currentSurface })) return;
    setCreateError(null);
    setIsExiting(true);
    exitCoordinator().begin(() => router.push("/chat/new"));
  }

  async function switchProfile() {
    await clearProfile();
    router.push("/");
  }

  return (
    <div className="min-h-dvh">
      <aside className={`fixed inset-y-0 left-0 z-30 w-[228px] flex-col px-5 py-6 ${profileId ? "hidden lg:flex" : "hidden"}`}>
        <div className="pointer-events-none absolute inset-y-0 left-0 right-[-72px] bg-gradient-to-r from-white/72 via-white/42 to-transparent backdrop-blur-2xl" aria-hidden="true" />
        <Link href="/" className="relative flex items-center gap-2.5 px-2" aria-label="Iris home"><IrisMark size={38} priority /><span className="text-[15px] font-semibold tracking-[-0.02em]">Iris</span></Link>

        <button type="button" onClick={() => void createNewChat()} disabled={isCreating} className="soft-press relative mt-9 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#111827] text-white shadow-[0_14px_30px_rgba(17,24,39,.16)] disabled:opacity-50" aria-label={isCreating ? "Creating new chat" : "New chat"} title="New chat">
          <PlusSymbol loading={isCreating} />
        </button>

        <nav className="relative mt-8 space-y-1" aria-label="Primary navigation">
          {navItems.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return <Link key={item.href} href={item.href} className={`flex h-11 items-center rounded-xl px-3 text-sm transition ${active ? "bg-white/72 font-semibold text-slate-950 shadow-[inset_0_0_0_1px_rgba(255,255,255,.7)]" : "font-medium text-slate-500 hover:bg-white/45 hover:text-slate-900"}`}><span className={`mr-3 h-1.5 w-1.5 rounded-full transition ${active ? "bg-[#4978ed] shadow-[0_0_0_4px_rgba(73,120,237,.12)]" : "bg-transparent"}`} />{item.label}</Link>;
          })}
        </nav>

        {profileId ? <button type="button" onClick={() => void switchProfile()} className="soft-press glass-surface relative mt-auto flex items-center gap-3 rounded-[20px] p-3 text-left" aria-label="Switch profile">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e7edff] text-xs font-bold text-[#4978ed]">{profileLabels[profileId].slice(0, 1)}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{profileLabels[profileId]}</span><span className="text-lg leading-none text-slate-400" aria-hidden="true">↔</span>
        </button> : <span className="relative mt-auto px-3 text-xs text-slate-400">{isReady ? "" : "Loading"}</span>}
      </aside>

      <div className={profileId ? "lg:pl-[228px]" : ""}>
        {!inChat ? <header className="fixed inset-x-0 top-0 z-20 h-[86px] lg:hidden">
          <ProceduralBlur edge="top" />
          <div className="relative flex h-16 items-center justify-between px-5 pt-[env(safe-area-inset-top)]">
            <Link href="/" className="flex items-center gap-2" aria-label="Iris home"><IrisMark size={34} priority /><span className="text-[15px] font-semibold tracking-tight">Iris</span></Link>
            {profileId ? <button type="button" onClick={() => void switchProfile()} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/68 text-xs font-bold text-[#4978ed] shadow-[inset_0_0_0_1px_rgba(255,255,255,.8)] backdrop-blur-xl" aria-label="Switch profile">{profileLabels[profileId].slice(0, 1)}</button> : null}
          </div>
        </header> : null}

        <main className={`relative overflow-x-clip ${inChat ? "min-h-dvh" : profileId ? "min-h-dvh pb-28 pt-16 lg:pb-8 lg:pt-0" : "min-h-dvh pt-16"}`}>
          <DelayedPagePresence active={!isReady} className="min-h-dvh">
            <div className={isExiting ? "chat-route-exit" : undefined}>{inChat ? <ChatScreen /> : children}</div>
          </DelayedPagePresence>
        </main>

        {!inChat && profileId ? <MobileNav pathname={pathname} profileId={profileId} isCreating={isCreating} error={createError} onCreateChat={() => void createNewChat()} /> : null}
      </div>
    </div>
  );
}

function PlusSymbol({ loading }: Readonly<{ loading: boolean }>) {
  return <span className={`relative h-[18px] w-[18px] ${loading ? "animate-spin rounded-full border-2 border-white/30 border-t-white" : ""}`} aria-hidden="true">{!loading ? <><span className="absolute left-1/2 top-0 h-[18px] w-[1.5px] -translate-x-1/2 rounded-full bg-white" /><span className="absolute left-0 top-1/2 h-[1.5px] w-[18px] -translate-y-1/2 rounded-full bg-white" /></> : null}</span>;
}
