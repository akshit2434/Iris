import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ProfileId } from "@/lib/profiles";
import { getThreadOverview } from "@/server/db/queries";
import type { AgentContext } from "@/server/agent/context";

export type ThreadOverview = {
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type ThreadOverviewReader = (
  profileId: ProfileId,
  threadId: string,
) => Promise<ThreadOverview | null>;

const emptyInput = z.object({});

export async function readCurrentTime(context: AgentContext) {
  return {
    kind: "current_time" as const,
    serverNow: context.serverNow,
    timezone: context.timezone,
  };
}

export async function readCurrentThreadOverview(
  context: AgentContext,
  reader: ThreadOverviewReader,
) {
  const overview = await reader(context.profileId, context.threadId);
  if (!overview) {
    return {
      kind: "thread_overview" as const,
      found: false as const,
      title: null,
      createdAt: null,
      updatedAt: null,
      messageCount: 0,
    };
  }

  return {
    kind: "thread_overview" as const,
    found: true as const,
    ...overview,
  };
}

export function createInternalTools(
  reader: ThreadOverviewReader = getThreadOverview,
) {
  const currentTime = tool(
    async (_input, runtime: ToolRuntime<unknown, AgentContext>) =>
      readCurrentTime(runtime.context),
    {
      name: "current_time",
      description: "Return the server time and the validated browser timezone for this run.",
      schema: emptyInput,
    },
  );

  const threadOverview = tool(
    async (_input, runtime: ToolRuntime<unknown, AgentContext>) =>
      readCurrentThreadOverview(runtime.context, reader),
    {
      name: "thread_overview",
      description: "Return only the current profile's current thread title, timestamps, and message count.",
      schema: emptyInput,
    },
  );

  return [currentTime, threadOverview] as const;
}
