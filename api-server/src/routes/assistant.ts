import { Router, type IRouter } from "express";
import OpenAI from "openai";
import {
  ExecuteAssistantActionBody,
  ExecuteAssistantActionParams,
  GetAssistantActivityResponse,
  GetAssistantContextResponse,
  SendAssistantMessageBody,
  SendAssistantMessageResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  buildWeatherResponse,
  isLiveWeatherRequest,
} from "../lib/weather";

type Activity = {
  id: string;
  action: string;
  detail: string | null;
  status: "completed" | "pending" | "blocked";
  actor: string;
  timestamp: string;
};

export type ServerContext = {
  name: string;
  id: string;
  ownerId: string | null;
  memberCount: number | null;
  channelCount: number;
  roleCount: number;
  channels: string[];
  roles: string[];
  createdAt: string;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

const router: IRouter = Router();
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const capabilities = [
  {
    id: "search-workspace",
    label: "Search workspace",
    description: "Find answers across your connected company information.",
    category: "Understand",
    available: true,
    requiresConfirmation: false,
  },
  {
    id: "draft-communications",
    label: "Draft communications",
    description: "Prepare clear updates for teams, customers, and partners.",
    category: "Communicate",
    available: true,
    requiresConfirmation: true,
  },
  {
    id: "manage-tasks",
    label: "Manage tasks",
    description: "Create, update, assign, and prioritize operational work.",
    category: "Execute",
    available: true,
    requiresConfirmation: true,
  },
  {
    id: "schedule-meetings",
    label: "Schedule meetings",
    description: "Coordinate time, attendees, and follow-up across calendars.",
    category: "Coordinate",
    available: true,
    requiresConfirmation: true,
  },
  {
    id: "review-access",
    label: "Review access",
    description: "Surface permissions, connected tools, and approval boundaries.",
    category: "Govern",
    available: true,
    requiresConfirmation: false,
  },
  {
    id: "loa-requests",
    label: "Leave of absence approvals",
    description:
      "Submit LOA requests in Discord and route them to configured approver roles.",
    category: "Govern",
    available: true,
    requiresConfirmation: true,
  },
  {
    id: "financial-actions",
    label: "Financial actions",
    description: "Review billing and payment work before anything is sent.",
    category: "Govern",
    available: false,
    requiresConfirmation: true,
  },
];

const suggestedPrompts = [
  "What needs my attention today?",
  "Draft an update for the team about this week's priorities.",
  "Find the latest customer issues and group them by urgency.",
  "Show me what the assistant has changed recently.",
];

let activity: Activity[] = [
  {
    id: "activity-104",
    action: "Workspace context loaded",
    detail: "Assistant checked available staff operations",
    status: "completed",
    actor: "Operations assistant",
    timestamp: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
  },
  {
    id: "activity-103",
    action: "Customer issue review",
    detail: "Waiting for staff approval before creating follow-up tasks",
    status: "pending",
    actor: "Operations assistant",
    timestamp: new Date(Date.now() - 1000 * 60 * 46).toISOString(),
  },
  {
    id: "activity-102",
    action: "Team update draft",
    detail: "Prepared a weekly priorities message",
    status: "completed",
    actor: "Alex Morgan",
    timestamp: new Date(Date.now() - 1000 * 60 * 132).toISOString(),
  },
  {
    id: "activity-101",
    action: "Access review",
    detail: "One financial capability still needs a connection",
    status: "blocked",
    actor: "Operations assistant",
    timestamp: new Date(Date.now() - 1000 * 60 * 285).toISOString(),
  },
];

const now = () => new Date().toISOString();

function action(
  id: string,
  label: string,
  description: string,
  tone: "neutral" | "positive" | "warning",
  requiresConfirmation = true,
) {
  return { id, label, description, tone, requiresConfirmation };
}

function serverInfoText(server: ServerContext) {
  const channelSummary = server.channels.length
    ? server.channels.join(", ")
    : "No channels found";
  const roleSummary = server.roles.length
    ? server.roles.join(", ")
    : "No custom roles found";
  return [
    `Server information for ${server.name}`,
    `ID: ${server.id}`,
    `Owner ID: ${server.ownerId ?? "Unavailable"}`,
    `Members: ${server.memberCount ?? "Unavailable"}`,
    `Channels (${server.channelCount}): ${channelSummary}`,
    `Roles (${server.roleCount}): ${roleSummary}`,
    `Created: ${server.createdAt}`,
  ].join("\n");
}

function serverListText(
  label: "Channels" | "Roles",
  items: string[],
  total: number,
) {
  return `${label} (${total}):\n${items.length ? items.join("\n") : "No items found."}`;
}

export function interpret(message: string, server?: ServerContext) {
  const normalized = message.toLowerCase();

  if (
    server &&
    (normalized.includes("server info") ||
      normalized.includes("server details") ||
      normalized.includes("guild info") ||
      normalized.includes("about this server") ||
      (normalized.includes("server") && normalized.includes("information")))
  ) {
    return {
      text: serverInfoText(server),
      actions: [],
    };
  }

  if (
    normalized === "hi" ||
    normalized === "hello" ||
    normalized === "hey" ||
    normalized.startsWith("good morning") ||
    normalized.startsWith("good afternoon") ||
    normalized.startsWith("good evening")
  ) {
    return {
      text: "Hi! I can help with everyday questions, live weather, server information, staff priorities, drafts, customer issues, and activity history.",
      actions: [],
    };
  }

  if (
    normalized.includes("what can you do") ||
    normalized === "help" ||
    normalized === "commands"
  ) {
    return {
      text: "Try asking about the weather, your Discord server, daily priorities, team drafts, customer issues, or recent activity. I’ll answer directly when I can and ask for confirmation before changes.",
      actions: [],
    };
  }

  if (
    normalized.includes("what time") ||
    normalized.includes("what date") ||
    normalized.includes("what day is it")
  ) {
    return {
      text: `The current time is ${new Date().toUTCString()} (UTC).`,
      actions: [],
    };
  }

  if (
    server &&
    (normalized.includes("list channel") ||
      normalized.includes("show channel") ||
      normalized.includes("what channel"))
  ) {
    return {
      text: serverListText("Channels", server.channels, server.channelCount),
      actions: [],
    };
  }

  if (
    server &&
    (normalized.includes("list role") ||
      normalized.includes("show role") ||
      normalized.includes("what role"))
  ) {
    return {
      text: serverListText("Roles", server.roles, server.roleCount),
      actions: [],
    };
  }

  if (
    normalized.includes("attention") ||
    normalized.includes("today") ||
    normalized.includes("urgent")
  ) {
    return {
      text: "I found three items that deserve attention: one customer issue waiting on a reply, a task that is past due, and a team update that is ready to send. I can turn the first two into a focused action list.",
      actions: [
        action(
          "create-priority-task",
          "Create priority action list",
          "Create two follow-up tasks from the items needing attention.",
          "positive",
        ),
        action(
          "draft-attention-update",
          "Draft a status update",
          "Prepare a concise update for the team with the current risks and owners.",
          "neutral",
        ),
      ],
    };
  }

  if (
    normalized.includes("draft") ||
    normalized.includes("update") ||
    normalized.includes("message") ||
    normalized.includes("communicat")
  ) {
    return {
      text: "I can prepare that. I’ll keep it concise, include the current priorities, and leave it as a draft for your review before anything is sent.",
      actions: [
        action(
          "draft-team-update",
          "Draft team update",
          "Create a reviewable weekly priorities message for the team.",
          "positive",
        ),
      ],
    };
  }

  if (
    normalized.includes("customer") ||
    normalized.includes("issue") ||
    normalized.includes("ticket")
  ) {
    return {
      text: "I found four open customer issues. Two are urgent, one is waiting for more information, and one can be grouped into the next support batch. I can create the follow-up work without sending anything externally.",
      actions: [
        action(
          "create-customer-followups",
          "Create customer follow-ups",
          "Create an assigned follow-up task for each urgent customer issue.",
          "warning",
        ),
        action(
          "draft-customer-summary",
          "Draft customer summary",
          "Prepare a shareable summary of the open issues and their current owners.",
          "neutral",
        ),
      ],
    };
  }

  if (
    normalized.includes("recent") ||
    normalized.includes("changed") ||
    normalized.includes("activity") ||
    normalized.includes("audit")
  ) {
    return {
      text: "The activity trail is current. The latest work was a workspace context check, a pending customer issue review, and a completed team update draft. Nothing was sent or changed without confirmation.",
      actions: [
        action(
          "open-activity-trail",
          "Review full activity trail",
          "Open the complete record of assistant operations and approval states.",
          "neutral",
          false,
        ),
      ],
    };
  }

  return {
    text: "I can help with workspace search, customer and task follow-up, team communications, scheduling, access reviews, and more. Tell me the outcome you want, and I’ll first show you what I plan to do.",
    actions: [
      action(
        "create-priority-task",
        "Turn a request into tasks",
        "Create a structured action list from your next request.",
        "neutral",
      ),
      action(
        "draft-team-update",
        "Draft a communication",
        "Prepare a message for review without sending it.",
        "neutral",
      ),
    ],
  };
}

async function generateAssistantText(
  message: string,
  fallback: string,
  server?: ServerContext,
  history: ConversationTurn[] = [],
) {
  if (!openai) return fallback;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 700,
      messages: [
        {
          role: "system",
          content:
            "You are the Staff Operations Bot. Be concise, practical, and transparent. " +
            "You are operating in a demo workspace with capabilities for searching workspace information, " +
            "drafting communications, managing tasks, scheduling meetings, and reviewing access. " +
            "When a Discord server context is supplied, use it to answer server, channel, role, " +
            "member, and owner questions. " +
            "You can also answer normal everyday conversation naturally and concisely. " +
            "Do not claim to have searched or changed external systems. Explain that proposed actions are " +
            "reviewable and require confirmation when they change data or communicate externally. " +
            "Return plain text only, no markdown headings, no emojis. Use the supplied operational context " +
            "and the deterministic action suggestions as your boundaries.",
        },
        ...history.slice(-8).map((turn) => ({
          role: turn.role,
          content: turn.content.slice(0, 2000),
        })),
        {
          role: "user",
          content: [
            `User message: ${message}`,
            `Operational context: ${fallback}`,
            server
              ? `Discord server context: ${JSON.stringify(server)}`
              : "Discord server context: unavailable",
          ].join("\n\n"),
        },
      ],
    });
    return response.choices[0]?.message?.content?.trim() || fallback;
  } catch (error) {
    logger.warn({ err: error }, "Assistant model request failed; using safe fallback");
    return fallback;
  }
}

const deterministicTerms = [
  "attention",
  "today",
  "urgent",
  "draft",
  "update",
  "message",
  "communicat",
  "customer",
  "issue",
  "ticket",
  "recent",
  "changed",
  "activity",
  "audit",
  "server info",
  "server details",
  "guild info",
  "about this server",
  "list channel",
  "show channel",
  "what channel",
  "list role",
  "show role",
  "what role",
];

function needsModel(message: string) {
  const normalized = message.toLowerCase();
  return !deterministicTerms.some((term) => normalized.includes(term));
}

export async function buildAssistantResponse(
  message: string,
  server?: ServerContext,
  history: ConversationTurn[] = [],
) {
  if (isLiveWeatherRequest(message)) {
    return { text: await buildWeatherResponse(message), actions: [] };
  }

  const interpreted = interpret(message, server);
  const text = needsModel(message)
    ? await generateAssistantText(message, interpreted.text, server, history)
    : interpreted.text;
  return { text, actions: interpreted.actions };
}

const actionLabels: Record<string, string> = {
  "create-priority-task": "Priority action list created",
  "draft-attention-update": "Status update draft created",
  "draft-team-update": "Team update draft created",
  "create-customer-followups": "Customer follow-up tasks created",
  "draft-customer-summary": "Customer summary draft created",
};

export function executeAssistantOperation(
  actionId: string,
  confirmation: boolean,
  note?: string | null,
  actor = "Alex Morgan",
) {
  if (actionId === "open-activity-trail") {
    const item = {
      id: `activity-${Date.now()}`,
      action: "Activity trail opened",
      detail: "Reviewed recent assistant operations",
      status: "completed" as const,
      actor,
      timestamp: now(),
    };
    activity = [item, ...activity];
    return {
      status: 200,
      body: {
        success: true,
        message: "The activity trail is ready to review.",
        activity: item,
      },
    };
  }

  if (!confirmation) {
    return {
      status: 400,
      body: { error: "This operation requires confirmation before it can run." },
    };
  }

  const label = actionLabels[actionId];
  if (!label) {
    return { status: 404, body: { error: "That operation is not available." } };
  }

  const item = {
    id: `activity-${Date.now()}`,
    action: label,
    detail: note || "Completed after staff confirmation",
    status: "completed" as const,
    actor,
    timestamp: now(),
  };
  activity = [item, ...activity];
  return {
    status: 200,
    body: {
      success: true,
      message: `${label}. Nothing was sent externally without a separate approval.`,
      activity: item,
    },
  };
}

router.get("/assistant/context", (_req, res) => {
  const data = GetAssistantContextResponse.parse({
    staff: { name: "Alex Morgan", role: "Operations lead", initials: "AM" },
    capabilities,
    activity: activity.slice(0, 6),
    suggestedPrompts,
    online: true,
  });
  res.json(data);
});

router.get("/assistant/activity", (_req, res) => {
  res.json(GetAssistantActivityResponse.parse(activity.slice(0, 20)));
});

router.post("/assistant/messages", async (req, res) => {
  const parsed = SendAssistantMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A message is required." });
    return;
  }

  const conversationId = parsed.data.conversationId ?? `conversation-${Date.now()}`;
  const response = await buildAssistantResponse(parsed.data.message);
  res.json(
    SendAssistantMessageResponse.parse({
      id: `assistant-${Date.now()}`,
      conversationId,
      text: response.text,
      timestamp: now(),
      actions: response.actions,
    }),
  );
});

router.post("/assistant/actions/:actionId/execute", (req, res) => {
  const params = ExecuteAssistantActionParams.safeParse(req.params);
  const body = ExecuteAssistantActionBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "That operation could not be understood." });
    return;
  }

  const result = executeAssistantOperation(
    params.data.actionId,
    body.data.confirmation ?? false,
    body.data.note,
  );
  res.status(result.status).json(result.body);
});

export default router;