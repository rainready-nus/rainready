/**
 * Event participants: join links, consent and unsubscribe.
 *
 * Participants add themselves through the event's join link and must tick a consent box; the
 * exact consent text is stored with the time. Every email RainReady sends them has an
 * unsubscribe link. Organisers can remove a participant, which deletes the record.
 */
import { randomBytes } from "node:crypto";

export class ParticipantValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParticipantValidationError";
  }
}

const EMAIL_PATTERN = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const newToken = () => randomBytes(24).toString("base64url"); // 32 characters
export const isToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(value);

export function normaliseEmail(value) {
  if (typeof value !== "string") throw new ParticipantValidationError("Enter your email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new ParticipantValidationError("Enter a valid email address.");
  return email;
}

export function cleanName(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ParticipantValidationError("Name must be text.");
  const name = value.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().replace(/\s+/g, " ");
  if (name.length > 80) throw new ParticipantValidationError("Name must be 80 characters or fewer.");
  return name;
}

/** The exact words the participant agrees to; stored with their record. */
export function consentText(eventName) {
  return `I agree that the organiser of "${eventName}" may send me email updates about this event through RainReady, `
    + "such as a change of venue, a postponement or a cancellation. I can unsubscribe at any time using the link in any email.";
}

export function validateJoin(body, target) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ParticipantValidationError("Send your details as JSON.");
  if (body.consent !== true) throw new ParticipantValidationError("Tick the box to agree to receive event updates.");
  return { email: normaliseEmail(body.email), name: cleanName(body.name), consentSource: "join_link", consentText: consentText(target.name) };
}

/** Synthetic participants for developer demos: @example.com addresses only, never real people. */
export function demoParticipants(count = 3) {
  const n = Math.max(1, Math.min(10, Number.isInteger(count) ? count : 3));
  return Array.from({ length: n }, (_, index) => {
    const tag = randomBytes(3).toString("hex");
    return {
      email: `demo-participant-${tag}@example.com`,
      name: `Demo participant ${index + 1}`,
      consentSource: "demo",
      consentText: "Synthetic demo participant added by a RainReady developer (example.com address, no real person).",
    };
  });
}

export function joinUrl(publicUrl, token) {
  return `${publicUrl}/join/${encodeURIComponent(token)}`;
}

export function unsubscribeUrl(publicUrl, token) {
  return `${publicUrl}/unsubscribe/${encodeURIComponent(token)}`;
}
