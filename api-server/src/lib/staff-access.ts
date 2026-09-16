import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import { PermissionsBitField } from "discord.js";
import { eq } from "drizzle-orm";
import { db, staffRoleConfigsTable } from "@workspace/db";

export type StaffRole = "owner" | "admin" | "manager" | "staff" | "viewer";
export const STAFF_ACCESS_ERROR =
  "Error Could Not find Staff roles or user is not staff";

const rank: Record<StaffRole, number> = {
  viewer: 0,
  staff: 1,
  manager: 2,
  admin: 3,
  owner: 4,
};

export type StaffRoleConfigInput = {
  guildId: string;
  ownerRoleId: string;
  adminRoleId: string;
  managerRoleId: string;
  staffRoleId: string;
  loaApproverRoleIds: string[];
};

export async function getStaffRoleConfig(guildId: string) {
  const [config] = await db
    .select()
    .from(staffRoleConfigsTable)
    .where(eq(staffRoleConfigsTable.guildId, guildId))
    .limit(1);
  return config ?? null;
}

export async function setStaffRoleConfig(config: StaffRoleConfigInput) {
  const [saved] = await db
    .insert(staffRoleConfigsTable)
    .values(config)
    .onConflictDoUpdate({
      target: staffRoleConfigsTable.guildId,
      set: {
        ownerRoleId: config.ownerRoleId,
        adminRoleId: config.adminRoleId,
        managerRoleId: config.managerRoleId,
        staffRoleId: config.staffRoleId,
        loaApproverRoleIds: config.loaApproverRoleIds,
        updatedAt: new Date(),
      },
    })
    .returning();
  return saved;
}

export async function getLoaApproverRoleIds(guildId: string) {
  const config = await getStaffRoleConfig(guildId);
  return config?.loaApproverRoleIds ?? [];
}

export async function isLoaApprover(
  guildId: string,
  member: GuildMember | null,
) {
  const approverRoleIds = await getLoaApproverRoleIds(guildId);
  if (!member || approverRoleIds.length === 0) return false;
  return approverRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

export async function getStaffRole(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<StaffRole | null> {
  if (!interaction.inGuild() || !interaction.guildId) return null;

  const config = await getStaffRoleConfig(interaction.guildId);
  if (!config) return null;
  const member = await interaction.guild?.members
    .fetch(interaction.user.id)
    .catch(() => null);
  return getStaffRoleForMember(interaction.guildId, member ?? null);
}

export async function getStaffRoleForMember(
  guildId: string,
  member: GuildMember | null,
): Promise<StaffRole | null> {
  const config = await getStaffRoleConfig(guildId);
  if (!config || !member) return null;
  const roleIds = new Set(member.roles.cache.keys());
  if (roleIds.has(config.ownerRoleId)) return "owner";
  if (roleIds.has(config.adminRoleId)) return "admin";
  if (roleIds.has(config.managerRoleId)) return "manager";
  if (roleIds.has(config.staffRoleId)) return "staff";
  return null;
}

export async function canConfigureStaffRoles(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.inGuild() || !interaction.guildId) return false;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  if (
    interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)
  ) {
    return true;
  }
  const role = await getStaffRole(interaction);
  return role === "owner" || role === "admin";
}

export function canRunAction(actionId: string, role: StaffRole | null) {
  if (!role) return false;
  const requiredRole: StaffRole =
    actionId === "open-activity-trail"
      ? "viewer"
      : actionId.startsWith("draft-")
        ? "staff"
        : "manager";
  return rank[role] >= rank[requiredRole];
}

export function roleLabel(role: StaffRole) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}