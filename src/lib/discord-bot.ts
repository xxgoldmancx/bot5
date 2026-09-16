import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  Message,
  GatewayIntentBits,
  ModalBuilder,
  PermissionsBitField,
  REST,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import {
  buildAssistantResponse,
  executeAssistantOperation,
  type ConversationTurn,
  type ServerContext,
} from "../routes/assistant";
import {
  canRunAction,
  canConfigureStaffRoles,
  getStaffRole,
  getStaffRoleForMember,
  getLoaApproverRoleIds,
  isLoaApprover,
  roleLabel,
  setStaffRoleConfig,
  STAFF_ACCESS_ERROR,
  type StaffRole,
} from "./staff-access";
import {
  claimLoaRequest,
  createLoaRequest,
  decideLoaRequest,
  getLoaRequest,
  releaseLoaRequest,
} from "./loa-requests";
import { logger } from "./logger";

type DiscordReplyPayload = {
  embeds: EmbedBuilder[];
  components?: Array<
    | ActionRowBuilder<ButtonBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>
  >;
  allowedMentions?: { repliedUser?: boolean; roles?: string[] };
  ephemeral?: boolean;
};

type LoaDraft = {
  guildId: string;
  requesterId: string;
  requesterName: string;
  requestText: string;
  startDate?: string;
};

const loaDrafts = new Map<string, LoaDraft>();
const conversationHistory = new Map<
  string,
  { updatedAt: number; turns: ConversationTurn[] }
>();
const VERIFICATION_CHANNEL_NAME = "verify";
const VERIFIED_ROLE_NAME = "Verified";
const CONVERSATION_TTL_MS = 30 * 60 * 1000;

function responseEmbed(title: string, description: string, color = 0x5865f2) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

function actionButtons(
  actions: Array<{ id: string; label: string }>,
  role: StaffRole,
) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    actions.slice(0, 5).map((item) =>
      new ButtonBuilder()
        .setCustomId(`task:run:${item.id}`)
        .setLabel(
          canRunAction(item.id, role)
            ? item.label.slice(0, 80)
            : `${item.label.slice(0, 62)} · manager only`,
        )
        .setStyle(ButtonStyle.Secondary),
    ),
  );
}

function confirmationButtons(actionId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`task:confirm:${actionId}`)
      .setLabel("Confirm and run")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`task:cancel:${actionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

function loaButtons(requestId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`loa:approve:${requestId}`)
      .setLabel("Approve LOA")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`loa:decline:${requestId}`)
      .setLabel("Decline LOA")
      .setStyle(ButtonStyle.Danger),
  );
}

function verificationButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("verification:verify")
      .setLabel("Verify me")
      .setStyle(ButtonStyle.Success),
  );
}

function loaDateChoice(draftId: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`loa:date-choice:${draftId}`)
      .setPlaceholder("Choose the LOA start date")
      .addOptions(
        {
          label: "Start on the date of this request",
          description: "Use today's date as the LOA start date",
          value: "request-date",
        },
        {
          label: "Enter a manual start date",
          description: "Enter the start date as MM-DD-YYYY",
          value: "manual-date",
        },
      ),
  );
}

function loaEndDateButton(draftId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`loa:end-choice:${draftId}`)
      .setLabel("Enter LOA end date")
      .setStyle(ButtonStyle.Primary),
  );
}

function loaDateModal(
  draftId: string,
  kind: "start" | "end",
  currentValue?: string,
) {
  const input = new TextInputBuilder()
    .setCustomId("loa-date")
    .setLabel(kind === "start" ? "LOA start date" : "LOA end date")
    .setPlaceholder("MM-DD-YYYY")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  if (currentValue) input.setValue(currentValue);

  return new ModalBuilder()
    .setCustomId(`loa:${kind}:${draftId}`)
    .setTitle(kind === "start" ? "Enter LOA start date" : "Enter LOA end date")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
}

function isoDateFromDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function parseUsDate(value: string) {
  const match = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  const isoValue = `${year}-${month}-${day}`;
  const parsed = new Date(`${isoValue}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== isoValue
  ) {
    return null;
  }
  return isoValue;
}

function formatUsDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${month}-${day}-${year}`;
}

function safeName(value: string) {
  return value.replaceAll("`", "'");
}

function conversationKey(message: Message) {
  return [
    message.guild?.id ?? "dm",
    message.channelId,
    message.author.id,
  ].join(":");
}

function getConversationHistory(key: string) {
  const entry = conversationHistory.get(key);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversationHistory.delete(key);
    return [];
  }
  return entry.turns.slice(-8);
}

function rememberConversation(
  key: string,
  userMessage: string,
  assistantMessage: string,
) {
  const turns = getConversationHistory(key);
  conversationHistory.set(key, {
    updatedAt: Date.now(),
    turns: [
      ...turns,
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantMessage },
    ].slice(-8),
  });
}

function findNamedTextChannel(
  guild: Guild,
  name: string,
): TextChannel | NewsChannel | null {
  const normalizedName = name.toLowerCase();
  const channel = guild.channels.cache.find(
    (candidate) =>
      candidate.name.toLowerCase() === normalizedName &&
      (candidate.type === ChannelType.GuildText ||
        candidate.type === ChannelType.GuildAnnouncement),
  );
  if (!channel) return null;
  return channel.type === ChannelType.GuildText
    ? (channel as TextChannel)
    : (channel as NewsChannel);
}

function findLoaRole(guild: Guild) {
  return (
    guild.roles.cache.find((role) => role.name.toLowerCase() === "loa") ?? null
  );
}

function findVerifiedRole(guild: Guild) {
  return (
    guild.roles.cache.find(
      (role) => role.name.toLowerCase() === VERIFIED_ROLE_NAME.toLowerCase(),
    ) ?? null
  );
}

function verificationInfoEmbed(
  guild: Guild,
  member: import("discord.js").GuildMember,
) {
  const channel = findNamedTextChannel(guild, VERIFICATION_CHANNEL_NAME);
  const role = findVerifiedRole(guild);
  const isVerified = Boolean(role && member.roles.cache.has(role.id));
  const channelLabel = channel
    ? `<#${channel.id}>`
    : `Create a text channel named \`#${VERIFICATION_CHANNEL_NAME}\``;
  const roleLabel = role
    ? `<@&${role.id}>`
    : `Create a role named \`${VERIFIED_ROLE_NAME}\``;

  return new EmbedBuilder()
    .setTitle("Server Verification")
    .setDescription(
      "Welcome to the server. Verification is open to every member and only takes a moment.",
    )
    .addFields(
      {
        name: "Where",
        value: `Go to ${channelLabel}.`,
        inline: false,
      },
      {
        name: "Steps",
        value: [
          `1. Open ${channelLabel}.`,
          "2. Type `!verify` or press **Verify me**.",
          `3. You will receive the ${roleLabel} role immediately.`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Your status",
        value: isVerified
          ? "You are already verified. These instructions are still available whenever you need them."
          : "You are not verified yet.",
        inline: false,
      },
    )
    .setColor(isVerified ? 0x57f287 : 0x5865f2)
    .setFooter({ text: "Verification is available to every server member." })
    .setTimestamp();
}

function isVerificationHelpRequest(request: string) {
  return /\b(?:verify|verification|verified)\b/i.test(request);
}

async function completeVerification(
  guild: Guild,
  member: import("discord.js").GuildMember,
  channelId: string,
) {
  const channel = findNamedTextChannel(guild, VERIFICATION_CHANNEL_NAME);
  if (!channel) {
    return {
      ok: false as const,
      title: "Verification is not configured",
      description: `An administrator must create a text channel named \`${VERIFICATION_CHANNEL_NAME}\` first.`,
    };
  }

  if (channel.id !== channelId) {
    return {
      ok: false as const,
      title: "Verify in the verification channel",
      description: `Please go to ${channel} and use \`!verify\` there.`,
    };
  }

  const role = findVerifiedRole(guild);
  if (!role) {
    return {
      ok: false as const,
      title: "Verification is not configured",
      description: `An administrator must create a role named \`${VERIFIED_ROLE_NAME}\` first.`,
    };
  }

  if (member.roles.cache.has(role.id)) {
    return {
      ok: true as const,
      alreadyVerified: true,
      role,
    };
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return {
      ok: false as const,
      title: "Verification needs one bot permission",
      description:
        "An administrator must grant the bot **Manage Roles** permission.",
    };
  }

  if (role.managed || role.position >= botMember.roles.highest.position) {
    return {
      ok: false as const,
      title: "Verification role hierarchy needs attention",
      description: `Move the bot's highest role above \`${safeName(role.name)}\` so it can assign the verification role.`,
    };
  }

  try {
    await member.roles.add(role, "Member completed server verification");
    return {
      ok: true as const,
      alreadyVerified: false,
      role,
    };
  } catch (error) {
    logger.error({ err: error, roleId: role.id }, "Could not assign verified role");
    return {
      ok: false as const,
      title: "Verification could not be completed",
      description:
        "I could not assign the Verified role. Check the bot's Manage Roles permission and role hierarchy.",
    };
  }
}

async function handleVerificationHelp(message: Message) {
  if (!message.guild || !message.member) return;
  const channel = findNamedTextChannel(message.guild, VERIFICATION_CHANNEL_NAME);
  await message.reply({
    embeds: [verificationInfoEmbed(message.guild, message.member)],
    components: channel?.id === message.channelId ? [verificationButton()] : [],
    allowedMentions: { repliedUser: false },
  });
}

async function handleVerifyCommand(message: Message) {
  if (!message.guild || !message.member) {
    await message.reply({
      embeds: [
        responseEmbed(
          "Verification is only available in the server",
          "Use `!verify` inside the server's verification channel.",
          0xed4245,
        ),
      ],
    });
    return;
  }

  const result = await completeVerification(
    message.guild,
    message.member,
    message.channelId,
  );
  if (!result.ok) {
    await message.reply({
      embeds: [responseEmbed(result.title, result.description, 0xed4245)],
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  await message.reply({
    embeds: [
      responseEmbed(
        result.alreadyVerified ? "You are already verified" : "Verification complete",
        result.alreadyVerified
          ? "Your account already has the **Verified** role. You are all set."
          : "You're verified. Welcome to the server.",
        0x57f287,
      ),
    ],
    components: [verificationButton()],
    allowedMentions: { repliedUser: false },
  });
}

function limitedList(values: string[], limit = 24) {
  if (values.length <= limit) return values;
  return [...values.slice(0, limit), `… and ${values.length - limit} more`];
}

function getServerContext(guild: Guild): ServerContext {
  const channels = [...guild.channels.cache.values()]
    .sort(
      (a, b) =>
        ("position" in a ? a.position : 0) -
        ("position" in b ? b.position : 0),
    )
    .map((channel) => `\`${safeName(channel.name)}\` (${channel.type})`);
  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((role) => `\`${safeName(role.name)}\``);

  return {
    name: safeName(guild.name),
    id: guild.id,
    ownerId: guild.ownerId ?? null,
    memberCount: guild.memberCount ?? null,
    channelCount: channels.length,
    roleCount: roles.length,
    channels: limitedList(channels),
    roles: limitedList(roles),
    createdAt: guild.createdAt.toISOString(),
  };
}

async function handleRequest(
  reply: (payload: DiscordReplyPayload) => Promise<unknown>,
  request: string,
  role: StaffRole,
  server?: ServerContext,
  history: ConversationTurn[] = [],
) {
  if (!request) {
    await reply({
      embeds: [
        responseEmbed(
          "How to use !task",
          "Add a request after `!task`. Try `!task weather in Boston`, `!task server info`, or `!task draft a team update`.",
        ),
      ],
    });
    return null;
  }

  const response = await buildAssistantResponse(request, server, history);
  const buttons = response.actions.length
    ? [actionButtons(response.actions, role)]
    : [];
  await reply({
    embeds: [responseEmbed("Operations assistant", response.text)],
    components: buttons,
    allowedMentions: { repliedUser: false },
  });
  return response.text;
}

function isLoaRequest(request: string) {
  return /\b(?:loa|leave of absence|leave request|time off request)\b/i.test(
    request,
  );
}

async function handleLoaRequest(message: Message, requestText: string) {
  if (!message.guild) return;

  const approverRoleIds = await getLoaApproverRoleIds(message.guild.id);
  if (approverRoleIds.length === 0) {
    await message.reply({
      embeds: [
        responseEmbed(
          "LOA approval is not configured",
          "An administrator must run `/cmd set-roles` and select at least one LOA approver role before LOA requests can be submitted.",
          0xed4245,
        ),
      ],
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const resourcesChannel = findNamedTextChannel(
    message.guild,
    "staff-resources",
  );
  if (!resourcesChannel) {
    await message.reply({
      embeds: [
        responseEmbed(
          "LOA channel is not configured",
          'Create a text channel named "staff-resources" so LOA requests can be reviewed.',
          0xed4245,
        ),
      ],
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const draftId = randomUUID();
  loaDrafts.set(draftId, {
    guildId: message.guild.id,
    requesterId: message.author.id,
    requesterName: message.author.globalName ?? message.author.username,
    requestText: requestText.trim() || "No additional details provided.",
  });

  try {
    await message.reply({
      embeds: [
        responseEmbed(
          "LOA request — choose a start date",
          [
            "First, choose whether the LOA starts today or enter a manual start date.",
            "You will then be asked for the LOA end date.",
            "",
            "No request will be sent for approval until both dates are provided.",
          ].join("\n"),
        ),
      ],
      components: [loaDateChoice(draftId)],
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    loaDrafts.delete(draftId);
    logger.error({ err: error }, "Could not start LOA date form");
    await message.reply({
      embeds: [
        responseEmbed(
          "LOA date form could not be started",
          "I could not start the date selection form. Check the bot's Send Messages permission.",
          0xed4245,
        ),
      ],
      allowedMentions: { repliedUser: false },
    });
  }
}

async function submitLoaRequest(
  interaction: import("discord.js").ModalSubmitInteraction,
  draftId: string,
  endDate: string,
) {
  const draft = loaDrafts.get(draftId);
  if (!draft?.startDate || !interaction.guild) {
    await interaction.reply({
      embeds: [
        responseEmbed(
          "LOA request unavailable",
          "That LOA date form expired. Please start a new request with `!task LOA`.",
          0xed4245,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  if (endDate < draft.startDate) {
    await interaction.reply({
      embeds: [
        responseEmbed(
          "Invalid LOA end date",
          `The end date must be on or after the start date (${draft.startDate}).`,
          0xed4245,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const approverRoleIds = await getLoaApproverRoleIds(draft.guildId);
  const resourcesChannel = findNamedTextChannel(
    interaction.guild,
    "staff-resources",
  );
  if (approverRoleIds.length === 0 || !resourcesChannel) {
    await interaction.reply({
      embeds: [
        responseEmbed(
          "LOA request could not be submitted",
          'LOA approval roles and the "staff-resources" channel must be configured first.',
          0xed4245,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const loaRequest = await createLoaRequest({
    guildId: draft.guildId,
    requesterId: draft.requesterId,
    requesterName: draft.requesterName,
    requestText: draft.requestText,
    startDate: draft.startDate,
    endDate,
  });
  const roleMentions = approverRoleIds.map((roleId) => `<@&${roleId}>`);
  const details = loaRequest.requestText.slice(0, 3000);

  try {
    await resourcesChannel.send({
      embeds: [
        responseEmbed(
          "Leave of absence request",
          [
            `Requested by: **${safeName(loaRequest.requesterName)}**`,
            `Start date: **${formatUsDate(loaRequest.startDate)}**`,
            `End date: **${formatUsDate(loaRequest.endDate)}**`,
            `Details: ${details}`,
            `Approvers: ${roleMentions.join(", ")}`,
            "",
            "Status: **Pending approval**",
            "A member with any configured LOA approver role must choose Approve or Decline.",
          ].join("\n"),
          0xfee75c,
        ),
      ],
      components: [loaButtons(loaRequest.id)],
      allowedMentions: { repliedUser: false, roles: approverRoleIds },
    });
    loaDrafts.delete(draftId);
    await interaction.reply({
      embeds: [
        responseEmbed(
          "LOA request submitted",
          `Your request for **${formatUsDate(draft.startDate)}** through **${formatUsDate(endDate)}** was sent to ${resourcesChannel} and is waiting for approval.`,
        ),
      ],
      ephemeral: true,
    });
  } catch (error) {
    logger.error({ err: error }, "Could not post LOA request");
    await interaction.reply({
      embeds: [
        responseEmbed(
          "LOA request could not be posted",
          `I could not send the request to ${resourcesChannel}. Check the bot's View Channel and Send Messages permissions.`,
          0xed4245,
        ),
      ],
      ephemeral: true,
    });
  }
}

async function dmLoaDecision(
  interaction: import("discord.js").ButtonInteraction,
  request: {
    requesterId: string;
    startDate: string;
    endDate: string;
  },
  approved: boolean,
  approverName: string,
) {
  try {
    const requester = await interaction.client.users.fetch(request.requesterId);
    await requester.send({
      embeds: [
        responseEmbed(
          approved ? "Your LOA was approved" : "Your LOA was declined",
          [
            `Your leave of absence request for **${formatUsDate(request.startDate)}** through **${formatUsDate(request.endDate)}** was **${approved ? "approved" : "declined"}**.`,
            `Decision by: **${safeName(approverName)}**`,
            approved
              ? "The **LOA** role has been added to your account."
              : "No role changes were made.",
          ].join("\n"),
          approved ? 0x57f287 : 0xed4245,
        ),
      ],
    });
  } catch (error) {
    logger.warn(
      { err: error, requesterId: request.requesterId },
      "Could not DM LOA decision to requester",
    );
  }
}

export function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not configured; Discord bot is disabled");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      { username: readyClient.user.username },
      "Discord operations bot ready",
    );
    const rest = new REST({ version: "10" }).setToken(token);
    const command = {
      name: "cmd",
      description: "Configure staff roles and approval boundaries",
      options: [
        {
          name: "set-roles",
          description: "Set staff roles and optional LOA approver roles",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "owner",
              description: "The role with full approval access",
              type: ApplicationCommandOptionType.Role,
              required: true,
            },
            {
              name: "admin",
              description: "The role with full approval access",
              type: ApplicationCommandOptionType.Role,
              required: true,
            },
            {
              name: "manager",
              description: "The role allowed to create tasks and drafts",
              type: ApplicationCommandOptionType.Role,
              required: true,
            },
            {
              name: "staff",
              description: "The role allowed to create drafts",
              type: ApplicationCommandOptionType.Role,
              required: true,
            },
            ...Array.from({ length: 5 }, (_, index) => ({
              name: `loa-role-${index + 1}`,
              description: `Optional LOA approver role ${index + 1}`,
              type: ApplicationCommandOptionType.Role,
              required: false,
            })),
          ],
        },
      ],
    };
    const guildIds = [...readyClient.guilds.cache.keys()];
    void Promise.all([
      rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: [command],
      }),
      ...guildIds.map((guildId) =>
        rest.put(Routes.applicationGuildCommands(readyClient.user.id, guildId), {
          body: [command],
        }),
      ),
    ])
      .then(() =>
        logger.info(
          { guildCount: guildIds.length },
          "Registered the /cmd Discord command globally and per server",
        ),
      )
      .catch((error) =>
        logger.error({ err: error }, "Could not register Discord commands"),
      );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (
        interaction.isChatInputCommand() &&
        interaction.commandName === "cmd"
      ) {
        await interaction.deferReply({ ephemeral: true });
        if (!interaction.inGuild() || !(await canConfigureStaffRoles(interaction))) {
          await interaction.editReply({
            embeds: [responseEmbed("Access denied", STAFF_ACCESS_ERROR, 0xed4245)],
          });
          return;
        }

        const ownerRole = interaction.options.getRole("owner", true);
        const adminRole = interaction.options.getRole("admin", true);
        const managerRole = interaction.options.getRole("manager", true);
        const staffRole = interaction.options.getRole("staff", true);
        const loaApproverRoleIds = Array.from({ length: 5 }, (_, index) =>
          interaction.options.getRole(`loa-role-${index + 1}`)?.id,
        ).filter((roleId): roleId is string => Boolean(roleId));
        const uniqueLoaApproverRoleIds = [...new Set(loaApproverRoleIds)];
        await setStaffRoleConfig({
          guildId: interaction.guildId,
          ownerRoleId: ownerRole.id,
          adminRoleId: adminRole.id,
          managerRoleId: managerRole.id,
          staffRoleId: staffRole.id,
          loaApproverRoleIds: uniqueLoaApproverRoleIds,
        });
        await interaction.editReply({
          embeds: [
            responseEmbed(
              "Staff roles saved",
              [
                `Owner: ${ownerRole.name}`,
                `Admin: ${adminRole.name}`,
                `Manager: ${managerRole.name}`,
                `Staff: ${staffRole.name}`,
                `LOA approvers: ${
                  uniqueLoaApproverRoleIds.length
                    ? uniqueLoaApproverRoleIds.map((roleId) => `<@&${roleId}>`).join(", ")
                    : "None configured"
                }`,
              ].join("\n"),
              0x57f287,
            ),
          ],
        });
        return;
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith("loa:date-choice:")
      ) {
        const [, , draftId] = interaction.customId.split(":");
        const draft = loaDrafts.get(draftId);
        if (
          !draft ||
          !interaction.inGuild() ||
          interaction.guildId !== draft.guildId ||
          interaction.user.id !== draft.requesterId
        ) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA form unavailable",
                "Only the person who started this LOA request can choose its dates.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        const choice = interaction.values[0];
        if (choice === "request-date") {
          draft.startDate = isoDateFromDate(interaction.createdAt);
          await interaction.showModal(loaDateModal(draftId, "end"));
        } else if (choice === "manual-date") {
          await interaction.showModal(loaDateModal(draftId, "start"));
        } else {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA form unavailable",
                "That date selection was not recognized. Please start a new LOA request.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
        }
        return;
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith("loa:")
      ) {
        const [, kind, draftId] = interaction.customId.split(":");
        const draft = loaDrafts.get(draftId);
        if (
          !draft ||
          !interaction.inGuild() ||
          interaction.guildId !== draft.guildId ||
          interaction.user.id !== draft.requesterId
        ) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA form unavailable",
                "Only the person who started this LOA request can enter its dates.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        const dateValue = interaction.fields
          .getTextInputValue("loa-date")
          .trim();
        const parsedDate = parseUsDate(dateValue);
        if (!parsedDate) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "Invalid date",
                "Enter the date in MM-DD-YYYY format, for example 09-15-2026.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        if (kind === "start") {
          draft.startDate = parsedDate;
          await interaction.reply({
            embeds: [
              responseEmbed(
                "Start date saved",
                `Start date: **${formatUsDate(parsedDate)}**\nClick below to enter the LOA end date.`,
              ),
            ],
            components: [loaEndDateButton(draftId)],
            ephemeral: true,
          });
        } else if (kind === "end") {
          await submitLoaRequest(interaction, draftId, parsedDate);
        } else {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA form unavailable",
                "That date form was not recognized. Please start a new LOA request.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
        }
        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith("loa:end-choice:")
      ) {
        const [, , draftId] = interaction.customId.split(":");
        const draft = loaDrafts.get(draftId);
        if (
          !draft ||
          !interaction.inGuild() ||
          interaction.guildId !== draft.guildId ||
          interaction.user.id !== draft.requesterId
        ) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA form unavailable",
                "Only the person who started this LOA request can enter its end date.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }
        await interaction.showModal(loaDateModal(draftId, "end"));
        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId === "verification:verify"
      ) {
        if (!interaction.inGuild() || !interaction.guild) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "Verification is only available in the server",
                "Use the verification button inside the server's verification channel.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
        if (!member) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "Verification could not be completed",
                "I could not find your member record in this server.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        const result = await completeVerification(
          interaction.guild,
          member,
          interaction.channelId,
        );
        await interaction.reply({
          embeds: [
            responseEmbed(
              result.ok
                ? result.alreadyVerified
                  ? "You are already verified"
                  : "Verification complete"
                : result.title,
              result.ok
                ? result.alreadyVerified
                  ? "Your account already has the **Verified** role. You are all set."
                  : "You're verified. Welcome to the server."
                : result.description,
              result.ok ? 0x57f287 : 0xed4245,
            ),
          ],
          ephemeral: true,
        });
        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith("loa:")
      ) {
        const [, decision, requestIdText] = interaction.customId.split(":");
        const requestId = Number(requestIdText);
        const member = interaction.inGuild()
          ? await interaction.guild?.members
              .fetch(interaction.user.id)
              .catch(() => null)
          : null;
        const canApprove =
          interaction.inGuild() &&
          Boolean(interaction.guildId) &&
          (await isLoaApprover(interaction.guildId!, member ?? null));

        if (!canApprove) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA approval denied",
                "Only members with one of the configured LOA approver roles can approve or decline this request.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        if (
          !Number.isInteger(requestId) ||
          !["approve", "decline"].includes(decision)
        ) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA request unavailable",
                "That LOA request could not be understood.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        const request = await getLoaRequest(requestId);
        if (!request) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA request unavailable",
                "That LOA request no longer exists.",
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        if (request.status !== "pending") {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA request already decided",
                `This request was already ${request.status}.`,
                0x95aab6,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        const approved = decision === "approve";
        const approverName =
          interaction.user.globalName ?? interaction.user.username;
        const claimed = await claimLoaRequest(requestId);
        if (!claimed) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA request already decided",
                "Another approver decided this request first.",
                0x95aab6,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        if (approved) {
          const guild = interaction.guild;
          const loaRole = guild ? findLoaRole(guild) : null;
          const updatesChannel = guild
            ? findNamedTextChannel(guild, "staff-updates")
            : null;
          if (!loaRole || !updatesChannel || !guild) {
            await releaseLoaRequest(requestId);
            await interaction.reply({
              embeds: [
                responseEmbed(
                  "LOA approval could not be completed",
                  'Approval requires a role named "LOA" and a text channel named "staff-updates". Create both, then try again.',
                  0xed4245,
                ),
              ],
              ephemeral: true,
            });
            return;
          }

          const requesterMember = await guild.members
            .fetch(request.requesterId)
            .catch(() => null);
          if (!requesterMember) {
            await releaseLoaRequest(requestId);
            await interaction.reply({
              embeds: [
                responseEmbed(
                  "LOA approval could not be completed",
                  "I could not find the requesting member in this server, so the LOA role was not added.",
                  0xed4245,
                ),
              ],
              ephemeral: true,
            });
            return;
          }

          try {
            await requesterMember.roles.add(
              loaRole,
              `LOA approved by ${approverName}`,
            );
            const requesterMention = `<@${request.requesterId}>`;
            const approverMention = `<@${interaction.user.id}>`;
            const approvalAnnouncement =
              request.requesterId === interaction.user.id
                ? `${requesterMention} has Requested LOA and has been approved`
                : `${requesterMention} has Requested LOA and has been approved by ${approverMention}`;
            await updatesChannel.send({
              content: approvalAnnouncement,
              embeds: [
                responseEmbed(
                  "LOA approved",
                  [
                    `${approvalAnnouncement}.`,
                    `Dates: **${formatUsDate(request.startDate)}** through **${formatUsDate(request.endDate)}**`,
                    "",
                    "The **LOA** role was added to the user.",
                  ].join("\n"),
                  0x57f287,
                ),
              ],
              allowedMentions: {
                users: [
                  ...new Set([request.requesterId, interaction.user.id]),
                ],
              },
            });
          } catch (error) {
            await releaseLoaRequest(requestId);
            logger.error({ err: error }, "Could not apply approved LOA");
            await interaction.reply({
              embeds: [
                responseEmbed(
                  "LOA approval could not be completed",
                  "I could not add the LOA role or post the staff update. Check the bot's Manage Roles permission, role hierarchy, and channel permissions.",
                  0xed4245,
                ),
              ],
              ephemeral: true,
            });
            return;
          }
        }

        const decided = await decideLoaRequest(
          requestId,
          approved ? "approved" : "declined",
          interaction.user.id,
          approverName,
        );
        if (!decided) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "LOA request already decided",
                "Another approver decided this request first.",
                0x95aab6,
              ),
            ],
            ephemeral: true,
          });
          return;
        }

        await dmLoaDecision(
          interaction,
          decided,
          approved,
          approverName,
        );
        await interaction.update({
          content: approved
            ? `<@${interaction.user.id}> approved this LOA request`
            : `<@${interaction.user.id}> declined this LOA request`,
          embeds: [
            responseEmbed(
              approved ? "LOA approved" : "LOA declined",
              [
                `Requested by: **${safeName(request.requesterName)}**`,
                `Decision: **${approved ? "Approved" : "Declined"}**`,
                `Decided by: <@${interaction.user.id}> (**${safeName(approverName)}**)`,
                `Start date: **${formatUsDate(request.startDate)}**`,
                `End date: **${formatUsDate(request.endDate)}**`,
                `Details: ${request.requestText.slice(0, 3000)}`,
              ].join("\n"),
              approved ? 0x57f287 : 0xed4245,
            ),
          ],
          components: [],
          allowedMentions: { users: [interaction.user.id] },
        });
        return;
      }

      if (!interaction.isButton() || !interaction.customId.startsWith("task:")) {
        return;
      }

      const [, verb, actionId] = interaction.customId.split(":");
      if (!actionId) return;
      const role = interaction.isRepliable() && interaction.inGuild()
        ? await getStaffRole(interaction)
        : "viewer";
      if (!role) {
        await interaction.reply({
          embeds: [responseEmbed("Access denied", STAFF_ACCESS_ERROR, 0xed4245)],
          ephemeral: true,
        });
        return;
      }

      if (verb === "run") {
        if (!canRunAction(actionId, role)) {
          await interaction.reply({
            embeds: [
              responseEmbed(
                "Approval boundary",
                `Your current Discord role (${roleLabel(role)}) cannot run this operation. Ask a manager or admin to approve it.`,
                0xed4245,
              ),
            ],
            ephemeral: true,
          });
          return;
        }
        await interaction.reply({
          embeds: [
            responseEmbed(
              "Approval required",
              "This action can change work or communicate externally. Review it here, then confirm if you want me to run it.",
              0xfee75c,
            ),
          ],
          components: [confirmationButtons(actionId)],
          ephemeral: true,
        });
        return;
      }

      if (verb === "cancel") {
        await interaction.update({
          embeds: [responseEmbed("Cancelled", "Nothing was changed.")],
          components: [],
        });
        return;
      }

      if (verb === "confirm") {
        if (!canRunAction(actionId, role)) {
          await interaction.update({
            embeds: [
              responseEmbed(
                "Approval denied",
                `Your current Discord role (${roleLabel(role)}) cannot approve this operation.`,
                0xed4245,
              ),
            ],
            components: [],
          });
          return;
        }
        const result = executeAssistantOperation(
          actionId,
          true,
          null,
          interaction.user.globalName ?? interaction.user.username,
        );
        await interaction.update({
          embeds: [
            responseEmbed(
              result.status === 200 ? "Operation complete" : "Operation failed",
              result.status === 200
                ? `Done. ${result.body.message}`
                : "I could not complete that operation. Nothing was changed.",
              result.status === 200 ? 0x57f287 : 0xed4245,
            ),
          ],
          components: [],
        });
      }
    } catch (error) {
      logger.error({ err: error }, "Discord action failed");
      if (
        interaction.isRepliable() &&
        (interaction.replied || interaction.deferred)
      ) {
        await interaction.editReply({
          embeds: [
            responseEmbed(
              "Operation failed",
              "I could not complete that operation. Nothing was changed.",
              0xed4245,
            ),
          ],
          components: [],
        });
      } else if (interaction.isRepliable()) {
        await interaction.reply({
          embeds: [
            responseEmbed(
              "Operation failed",
              "I could not complete that operation. Nothing was changed.",
              0xed4245,
            ),
          ],
          ephemeral: true,
        });
      }
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    const taskPrefix = message.content.match(/^!task(?:\s+|$)/i);
    const verificationPrefix = message.content.match(/^!verify(?:\s+|$)/i);
    if (message.author.bot) {
      return;
    }

    try {
      if (verificationPrefix) {
        await handleVerifyCommand(message);
        return;
      }

      if (taskPrefix) {
        if (!message.guild || !message.member) {
          await message.reply({
            embeds: [
              responseEmbed("Access denied", STAFF_ACCESS_ERROR, 0xed4245),
            ],
          });
          return;
        }

        const requestText = message.content.slice(taskPrefix[0].length).trim();
        if (isVerificationHelpRequest(requestText)) {
          await handleVerificationHelp(message);
          return;
        }

        const role = await getStaffRoleForMember(
          message.guild.id,
          message.member,
        );
        if (!role) {
          await message.reply({
            embeds: [
              responseEmbed("Access denied", STAFF_ACCESS_ERROR, 0xed4245),
            ],
          });
          return;
        }

        if (isLoaRequest(requestText)) {
          await handleLoaRequest(message, requestText);
          return;
        }

        await handleRequest(
          (payload) => message.reply(payload),
          requestText,
          role,
          getServerContext(message.guild),
          getConversationHistory(conversationKey(message)),
        );
        return;
      }

      if (message.content.trim().startsWith("!")) {
        return;
      }

      const requestText = message.content.trim();
      if (!requestText) {
        return;
      }

      const role = message.guild && message.member
        ? (await getStaffRoleForMember(message.guild.id, message.member)) ?? "viewer"
        : "viewer";
      if (isLoaRequest(requestText) && role === "viewer") {
        await message.reply({
          embeds: [
            responseEmbed(
              "LOA access denied",
              "Only configured staff members can submit an LOA request.",
              0xed4245,
            ),
          ],
          allowedMentions: { repliedUser: false },
        });
        return;
      }

      if (isLoaRequest(requestText)) {
        await handleLoaRequest(message, requestText);
        return;
      }

      const assistantMessage = await handleRequest(
        (payload) => message.reply(payload),
        requestText,
        role,
        message.guild ? getServerContext(message.guild) : undefined,
        getConversationHistory(conversationKey(message)),
      );
      if (assistantMessage) {
        rememberConversation(
          conversationKey(message),
          requestText,
          assistantMessage,
        );
      }
    } catch (error) {
      logger.error({ err: error }, "Discord message handling failed");
      await message.reply({
        embeds: [
          responseEmbed(
            "Message failed",
            "I could not respond to that message. Nothing was changed.",
            0xed4245,
          ),
        ],
        allowedMentions: { repliedUser: false },
      });
    }
  });

  client.login(token).catch((error) => {
    logger.error(
      { err: error },
      "Discord bot could not connect; check token and gateway intents",
    );
  });
}