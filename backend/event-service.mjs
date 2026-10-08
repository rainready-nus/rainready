import { randomUUID } from "node:crypto";

const SENSITIVITY_LEVELS = new Set(["low", "medium", "high"]);
const DECISION_LABELS = {
  continue: "Continue as planned",
  prepare: "Prepare contingency plan",
  relocate: "Relocate to backup venue",
  postpone: "Postpone the event",
  cancel: "Cancel the event",
};

export class EventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EventValidationError";
  }
}

function requiredText(value, field, maxLength = 160) {
  if (typeof value !== "string" || !value.trim()) throw new EventValidationError(`${field} is required`);
  const text = value.trim();
  if (text.length > maxLength) throw new EventValidationError(`${field} must be ${maxLength} characters or fewer`);
  return text;
}

function coordinate(value, field, min, max, required = true) {
  if (value === null || value === undefined || value === "") {
    if (!required) return null;
    throw new EventValidationError(`${field} is required`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new EventValidationError(`${field} must be between ${min} and ${max}`);
  return number;
}

function validateBackupVenue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new EventValidationError("backupVenue must be an object or null");
  const name = requiredText(value.name, "backupVenue.name", 160);
  const latitude = coordinate(value.latitude, "backupVenue.latitude", -90, 90, false);
  const longitude = coordinate(value.longitude, "backupVenue.longitude", -180, 180, false);
  if ((latitude === null) !== (longitude === null)) throw new EventValidationError("backup venue latitude and longitude must both be provided or both be empty");
  if (latitude === null) throw new EventValidationError("backup venue latitude and longitude are required");
  const address = typeof value.address === "string" ? value.address.trim().slice(0, 240) : "";
  return { name, address, latitude, longitude };
}

export function validateEventInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EventValidationError("event body must be a JSON object");
  const name = requiredText(input.name, "name", 120);
  const venue = requiredText(input.venue, "venue", 160);
  const latitude = coordinate(input.latitude, "latitude", -90, 90);
  const longitude = coordinate(input.longitude, "longitude", -180, 180);
  const date = requiredText(input.date, "date", 10);
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new EventValidationError("date must use YYYY-MM-DD format");
  }
  const time = requiredText(input.time, "time", 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new EventValidationError("time must use 24-hour HH:MM format");
  const type = requiredText(input.type, "type", 80);
  const sensitivity = input.sensitivity;
  if (!SENSITIVITY_LEVELS.has(sensitivity)) throw new EventValidationError("sensitivity must be low, medium, or high");
  const participantCount = Number(input.participantCount ?? 0);
  if (!Number.isInteger(participantCount) || participantCount < 0 || participantCount > 100000) {
    throw new EventValidationError("participantCount must be a whole number between 0 and 100000");
  }
  const backupVenue = validateBackupVenue(input.backupVenue);
  const venueAddress = typeof input.venueAddress === "string" ? input.venueAddress.trim().slice(0, 240) : "";
  return { name, venue, venueAddress, latitude, longitude, backupVenue, participantCount, date, time, type, sensitivity };
}

function validateDecisionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EventValidationError("decision body must be a JSON object");
  if (!Object.hasOwn(DECISION_LABELS, input.action)) throw new EventValidationError("action must be continue, prepare, relocate, postpone, or cancel");
  return { action: input.action, reason: requiredText(input.reason, "reason", 1000) };
}

function buildTestNotification(event, { action, reason }, decidedAt) {
  const label = DECISION_LABELS[action];
  const venueText = action === "relocate"
    ? `The event will move to ${event.backupVenue.name}.`
    : `The event is scheduled at ${event.venue} on ${event.date} at ${event.time} SGT.`;
  const actionText = action === "continue"
    ? `The organiser has decided to continue as planned. ${venueText}`
    : action === "prepare"
      ? `The organiser has decided to prepare the contingency plan. ${venueText}`
      : action === "relocate"
        ? `The organiser has decided to relocate. ${venueText}`
        : action === "postpone"
          ? "The organiser has decided to postpone the event. Please wait for an update from the organiser."
          : "The organiser has decided to cancel the event. Further information will be provided by the organiser.";
  return {
    mode: "test",
    status: "not_sent",
    generatedAt: decidedAt,
    intendedRecipientCount: event.participantCount,
    title: `${event.name}: ${label}`,
    message: `${event.name}: ${actionText}\nReason: ${reason}\n\nTEST MODE — this preview was not sent to participants.`,
  };
}

export function createEventService(store, { organizationId } = {}) {
  if (!store) throw new TypeError("store is required");
  if (typeof organizationId !== "string" || !organizationId) throw new TypeError("organizationId is required");
  return {
    list: () => store.list(organizationId),
    get: (id) => store.get(organizationId, id),
    create: (input) => store.create(organizationId, validateEventInput(input)),
    async update(id, input) {
      const current = await store.get(organizationId, id);
      if (!current) return null;
      return store.update(organizationId, id, validateEventInput({ ...current, ...input }));
    },
    async recordDecision(id, input) {
      const fields = validateDecisionInput(input);
      const event = await store.get(organizationId, id);
      if (!event) return null;
      if (fields.action === "relocate" && !event.backupVenue) {
        throw new EventValidationError("a backup venue must be set before recording a relocation decision");
      }
      const decidedAt = new Date().toISOString();
      const decision = {
        id: randomUUID(),
        ...fields,
        label: DECISION_LABELS[fields.action],
        decidedAt,
        testNotification: buildTestNotification(event, fields, decidedAt),
      };
      const updatedEvent = await store.addDecision(organizationId, id, decision);
      return updatedEvent ? { decision, event: updatedEvent } : null;
    },
    listDecisions: (id) => store.listDecisions(organizationId, id),
    delete: (id) => store.delete(organizationId, id),
  };
}

