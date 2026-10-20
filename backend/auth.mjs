import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH_BYTES = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

function validateEmail(value) {
  if (typeof value !== "string") throw new AuthError(400, "invalid_email", "Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError(400, "invalid_email", "Enter a valid email address.");
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) {
    throw new AuthError(400, "invalid_password", "Password must be between 12 and 128 characters.");
  }
  return value;
}

function passwordHash(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function verifyPassword(password, encoded) {
  const [, saltValue, hashValue] = String(encoded ?? "").split("$");
  if (!saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length, SCRYPT_OPTIONS);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// Every store call is awaited, so the same service works with the synchronous SQLite store
// (event-store.mjs) and the asynchronous PostgreSQL store (event-store-pg.mjs).
async function publicMemberships(authStore, userId) {
  return (await authStore.listMemberships(userId)).map(({ id, name, role }) => ({ id, name, role }));
}

export function createAuthService(authStore) {
  if (!authStore) throw new TypeError("authStore is required");

  async function createSession(userId) {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
    await authStore.createSession({ tokenHash: hashToken(token), userId, expiresAt, now: now.toISOString() });
    return { token, expiresAt };
  }

  return {
    async register({ email: emailInput, password: passwordInput, organizationName: orgInput, invitationCode: inviteInput }) {
      const email = validateEmail(emailInput);
      const password = validatePassword(passwordInput);
      const invitationCode = typeof inviteInput === "string" ? inviteInput.trim() : "";
      let organizationName = "";
      if (!invitationCode) {
        if (typeof orgInput !== "string" || !orgInput.trim() || orgInput.trim().length > 120) {
          throw new AuthError(400, "invalid_organization", "Enter an organization name (up to 120 characters), or join with an invitation code.");
        }
        organizationName = orgInput.trim();
      }
      if (invitationCode.length > 160) throw new AuthError(400, "invalid_invitation", "This invitation code is invalid.");
      const invitationTokenHash = invitationCode ? hashToken(invitationCode) : null;
      let account;
      try {
        account = await authStore.createAccount({
          userId: randomUUID(),
          email,
          passwordHash: passwordHash(password),
          organizationId: randomUUID(),
          organizationName,
          invitationTokenHash,
          now: new Date().toISOString(),
        });
      } catch (error) {
        if (error.code === "email_exists") throw new AuthError(409, error.code, error.message);
        if (error.code === "invalid_invitation") throw new AuthError(400, error.code, error.message);
        throw error;
      }
      return { user: { id: account.id, email: account.email }, organizations: await publicMemberships(authStore, account.id), session: await createSession(account.id) };
    },
    async login({ email: emailInput, password: passwordInput }) {
      const email = validateEmail(emailInput);
      if (typeof passwordInput !== "string" || passwordInput.length > 128) {
        throw new AuthError(400, "invalid_credentials", "Email or password is incorrect.");
      }
      const account = await authStore.findUserByEmail(email);
      const valid = verifyPassword(passwordInput, account?.password_hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      if (!account || !valid) throw new AuthError(401, "invalid_credentials", "Email or password is incorrect.");
      return { user: { id: account.id, email: account.email }, organizations: await publicMemberships(authStore, account.id), session: await createSession(account.id) };
    },
    async resolveSession(token) {
      if (typeof token !== "string" || token.length < 40 || token.length > 100) return null;
      const now = new Date().toISOString();
      const session = await authStore.getSession(hashToken(token), now);
      if (!session) return null;
      return { user: { id: session.user_id, email: session.email }, expiresAt: session.expires_at };
    },
    async logout(token) {
      if (typeof token === "string" && token.length >= 40 && token.length <= 100) await authStore.deleteSession(hashToken(token));
    },
    async logoutAll(userId) {
      return authStore.deleteUserSessions(userId);
    },
    async membership(userId, organizationId) {
      if (typeof organizationId !== "string" || organizationId.length > 80) return null;
      return authStore.getMembership(userId, organizationId);
    },
    async createInvitation({ userId, organizationId }) {
      const membership = await authStore.getMembership(userId, organizationId);
      if (!membership) throw new AuthError(403, "organization_access_denied", "You are not a member of this organization.");
      if (membership.role !== "owner") throw new AuthError(403, "owner_required", "Only an organization owner can invite members.");
      const code = randomBytes(32).toString("base64url");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS).toISOString();
      await authStore.createInvitation({ tokenHash: hashToken(code), organizationId, createdByUserId: userId, expiresAt, now: now.toISOString() });
      return { code, expiresAt, organizationName: membership.name };
    },
    async listMembers({ userId, organizationId }) {
      const membership = await authStore.getMembership(userId, organizationId);
      if (!membership) throw new AuthError(403, "organization_access_denied", "You are not a member of this organization.");
      if (membership.role !== "owner") throw new AuthError(403, "owner_required", "Only an organization owner can manage members.");
      return authStore.listOrganizationMembers(organizationId);
    },
    async removeMember({ userId, organizationId, targetUserId }) {
      const membership = await authStore.getMembership(userId, organizationId);
      if (!membership) throw new AuthError(403, "organization_access_denied", "You are not a member of this organization.");
      if (membership.role !== "owner") throw new AuthError(403, "owner_required", "Only an organization owner can manage members.");
      if (typeof targetUserId !== "string" || targetUserId.length > 80) {
        throw new AuthError(400, "invalid_member", "Select a valid organisation member.");
      }
      if (!(await authStore.removeOrganizationMember({ actorUserId: userId, organizationId, targetUserId }))) {
        throw new AuthError(400, "member_not_removable", "This member cannot be removed. Owners cannot be removed through this screen.");
      }
      return { removed: true };
    },
  };
}

export const SESSION_COOKIE_NAME = "rainready_session";
export const sessionCookie = (token, request, maxAgeSeconds = 12 * 60 * 60) => {
  const secure = request.socket.encrypted || process.env.RAINREADY_COOKIE_SECURE === "true" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
};
export const clearedSessionCookie = (request) => sessionCookie("", request, 0);

export function readSessionCookie(request) {
  const header = request.headers.cookie ?? "";
  const item = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  return item ? item.slice(SESSION_COOKIE_NAME.length + 1) : "";
}
