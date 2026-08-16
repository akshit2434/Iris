"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ProceduralBlur } from "@/components/procedural-blur";
import {
  MOBILE_NAV_DESTINATIONS,
  MOBILE_NAV_SLOTS,
  canCreateNewChat,
  isMobileNavActive,
  type MobileNavDestination,
  type MobileNavSlot,
} from "@/lib/mobile-nav";

type MobileNavProps = {
  pathname: string;
  profileId: string | null;
  isCreating: boolean;
  error: string | null;
  onCreateChat: () => void;
};

export function MobileNav({ pathname, profileId, isCreating, error, onCreateChat }: Readonly<MobileNavProps>) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-2 pb-[max(8px,env(safe-area-inset-bottom))] lg:hidden">
      <ProceduralBlur edge="bottom" />
      {error ? <p className="pointer-events-auto relative mx-auto mb-2 w-full max-w-[430px] rounded-xl bg-red-50/90 px-3 py-2 text-center text-xs font-medium text-red-600 shadow-sm backdrop-blur-xl" role="alert">{error}</p> : null}
      <nav className="glass-surface pointer-events-auto relative mx-auto grid h-[72px] w-full max-w-[430px] grid-cols-5 items-end rounded-[26px] p-1.5" aria-label="Mobile navigation">
        {MOBILE_NAV_SLOTS.map((slot) => slot === "new-chat"
          ? <NewChatNavItem key={slot} disabled={!canCreateNewChat(profileId, isCreating)} isCreating={isCreating} onClick={onCreateChat} />
          : <DestinationNavItem key={slot} destination={destinationForSlot(slot)} pathname={pathname} />)}
      </nav>
    </div>
  );
}

function destinationForSlot(slot: Exclude<MobileNavSlot, "new-chat">) {
  const destination = MOBILE_NAV_DESTINATIONS.find((item) => item.icon === slot);
  if (!destination) throw new Error(`Unknown mobile navigation slot: ${slot}`);
  return destination;
}

function DestinationNavItem({ destination, pathname }: Readonly<{ destination: MobileNavDestination; pathname: string }>) {
  const active = isMobileNavActive(destination.href, pathname);
  return (
    <Link
      href={destination.href}
      aria-label={destination.label}
      title={destination.label}
      aria-current={active ? "page" : undefined}
      className={`soft-press flex min-w-0 min-h-[58px] items-center justify-center rounded-[19px] px-0.5 transition-colors duration-200 motion-reduce:transition-none ${active ? "bg-white/78 text-slate-950 shadow-sm" : "text-slate-400 hover:bg-white/45 hover:text-slate-700"}`}
    >
      <MobileNavIcon name={destination.icon} />
    </Link>
  );
}

function NewChatNavItem({ disabled, isCreating, onClick }: Readonly<{ disabled: boolean; isCreating: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="New chat"
      title="New chat"
      className="soft-press flex min-w-0 min-h-[58px] items-center justify-center rounded-[19px] px-0.5 text-slate-700 transition-colors duration-200 motion-reduce:transition-none disabled:cursor-default disabled:opacity-60"
    >
      <span className="flex h-11 w-11 -translate-y-1 items-center justify-center rounded-[17px] bg-[#111827] text-white shadow-[0_10px_24px_rgba(17,24,39,.2)] transition-transform duration-200 group-hover:-translate-y-1.5 motion-reduce:transition-none">
        {isCreating ? <LoadingIcon /> : <MobileNavIcon name="new-chat" />}
      </span>
    </button>
  );
}

export function MobileNavIcon({ name }: Readonly<{ name: MobileNavSlot }>) {
  const common = { viewBox: "0 0 20 20", className: "h-[19px] w-[19px] shrink-0", fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.55, "aria-hidden": true };
  let icon: ReactNode;
  switch (name) {
    case "home":
      icon = <><path d="m3.25 8.75 6.75-5.5 6.75 5.5v7a1.25 1.25 0 0 1-1.25 1.25H4.5a1.25 1.25 0 0 1-1.25-1.25z" /><path d="M7.25 17v-4.25h5.5V17" /></>;
      break;
    case "history":
      icon = <><path d="M4.3 7.1A6.7 6.7 0 1 1 3.3 11" /><path d="M3.3 4.7v3.8h3.8M10 6.2v4l2.65 1.55" /></>;
      break;
    case "files":
      icon = <><path d="M5 2.9h5.6l4.4 4.3v9.9H5z" /><path d="M10.5 2.9v4.6H15M7.5 11h5M7.5 13.6h5" /></>;
      break;
    case "profile":
      icon = <><circle cx="10" cy="6.6" r="2.65" /><path d="M4.2 17c.75-2.6 2.65-4.1 5.8-4.1s5.05 1.5 5.8 4.1" /></>;
      break;
    case "new-chat":
      icon = <><path d="M10 4v12M4 10h12" strokeWidth="1.75" /></>;
      break;
    default:
      icon = null;
  }
  return <svg {...common}>{icon}</svg>;
}

function LoadingIcon() {
  return <span className="h-[17px] w-[17px] animate-spin rounded-full border-2 border-white/35 border-t-white motion-reduce:animate-none" aria-hidden="true" />;
}
