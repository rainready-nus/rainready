/**
 * Participant email notifications.
 *
 * An email goes out only after an organiser confirms a decision that changes what participants
 * must do (relocate, postpone or cancel) and leaves "Email participants" ticked. Each decision
 * gets at most one notification, and a second relocate/postpone/cancel email for the same event
 * within two minutes is refused as a double submit (each POST records a new decision).
 *
 *   RAINREADY_MAILER      outbox (default) | ses
 *   RAINREADY_MAIL_FROM   sender address, required for ses (must be verified in Amazon SES)
 *   RAINREADY_SES_REGION  SES region, default AWS_REGION or ap-southeast-1
 *   RAINREADY_PUBLIC_URL  base URL used in email links, default http://127.0.0.1:<PORT>
 *
 * "outbox" sends nothing: the emails are kept in the database and shown on the developer
 * outbox page. "ses" sends through Amazon SES v2 with the AWS credentials of the server (an
 * IAM role in the cloud). In the SES sandbox, only verified addresses receive mail.
 */
import { randomUUID } from "node:crypto";
import { unsubscribeUrl } from "./participants.mjs";

export const NOTIFY_ACTIONS = Object.freeze(["relocate", "postpone", "cancel"]);
export const MAX_RECIPIENTS = 500; // the join link refuses more (MAX_PARTICIPANTS_PER_EVENT)
const UNSUBSCRIBE_PLACEHOLDER = "{{unsubscribe_url}}";

export class MailerConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MailerConfigurationError";
  }
}

export function publicUrlFromEnv(environment = process.env) {
  const raw = String(environment.RAINREADY_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || `http://127.0.0.1:${Number(environment.PORT ?? 8787)}`;
  let url;
  try { url = new URL(raw); } catch { throw new MailerConfigurationError("RAINREADY_PUBLIC_URL is not a valid URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new MailerConfigurationError("RAINREADY_PUBLIC_URL must be a plain http(s) base URL, for example https://rainready.example.org");
  }
  return url.href.replace(/\/+$/, "");
}

export function mailerConfigFromEnv(environment = process.env) {
  const mode = String(environment.RAINREADY_MAILER ?? "outbox").trim().toLowerCase() || "outbox";
  if (!["outbox", "ses"].includes(mode)) throw new MailerConfigurationError(`RAINREADY_MAILER must be outbox or ses, not "${mode}"`);
  const from = String(environment.RAINREADY_MAIL_FROM ?? "").trim();
  if (mode === "ses" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from.replace(/^.*<([^>]+)>$/, "$1"))) {
    throw new MailerConfigurationError("RAINREADY_MAIL_FROM must be a verified sender address when RAINREADY_MAILER=ses");
  }
  return {
    mode,
    from: from || "RainReady <no-reply@example.com>",
    region: String(environment.RAINREADY_SES_REGION ?? environment.AWS_REGION ?? "ap-southeast-1").trim(),
    publicUrl: publicUrlFromEnv(environment),
  };
}

/** Returns { name, send({ to, subject, text, unsubscribeUrl }) -> { messageId } }. sesClient is injectable for tests. */
export function createMailer(config, { sesClient = null } = {}) {
  if (config.mode === "outbox") {
    return { name: "outbox", publicUrl: config.publicUrl, async send() { return { messageId: `outbox-${randomUUID()}` }; } };
  }
  let clientPromise = sesClient ? Promise.resolve({ client: sesClient, SendEmailCommand: class { constructor(input) { this.input = input; } } }) : null;
  const load = () => (clientPromise ??= import("@aws-sdk/client-sesv2").then(({ SESv2Client, SendEmailCommand }) => ({
    client: new SESv2Client({ region: config.region }), SendEmailCommand,
  })).catch(() => { throw new MailerConfigurationError("RAINREADY_MAILER=ses needs the @aws-sdk/client-sesv2 package: run npm install"); }));
  return {
    name: "ses",
    publicUrl: config.publicUrl,
    async send({ to, subject, text, unsubscribeUrl: link }) {
      const { client, SendEmailCommand } = await load();
      const result = await client.send(new SendEmailCommand({
        FromEmailAddress: config.from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" } },
            Headers: [
              { Name: "List-Unsubscribe", Value: `<${link}>` },
              { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
            ],
          },
        },
      }));
      return { messageId: result?.MessageId ?? null };
    },
  };
}

export function createConfiguredMailer(environment = process.env) {
  return createMailer(mailerConfigFromEnv(environment));
}

const singleLine = (value, max = 160) => String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

/** Subject and body template for a decision. The body holds {{unsubscribe_url}} for each recipient. */
export function composeDecisionEmail({ event, decision, organizationName, demo = false }) {
  const name = singleLine(event.name, 120);
  const when = `${event.date} at ${event.time} SGT`;
  let subject;
  let what;
  if (decision.action === "relocate") {
    const venue = event.backupVenue;
    subject = `${name}: moved to ${singleLine(venue?.name, 100)}`;
    what = [`The event is moving to a different venue.`, ``, `New venue: ${singleLine(venue?.name)}${venue?.address ? `, ${singleLine(venue.address, 240)}` : ""}`, `Date and time: ${when} (unchanged)`, `Previous venue: ${singleLine(event.venue)}`];
  } else if (decision.action === "postpone") {
    subject = `${name}: postponed`;
    what = [`The event on ${when} at ${singleLine(event.venue)} is postponed.`, `Please do not travel to the venue. The organiser will send a new date.`];
  } else {
    subject = `${name}: cancelled`;
    what = [`The event on ${when} at ${singleLine(event.venue)} is cancelled.`, `Please do not travel to the venue.`];
  }
  const body = [
    ...(demo ? [`DEMONSTRATION ONLY: this email was sent during a simulated weather alert in a RainReady demo. Nothing about the real event has changed.`, ``] : []),
    `Hello,`,
    ``,
    `${singleLine(organizationName, 120)} has an update about ${name}.`,
    ``,
    ...what,
    ``,
    `Reason from the organiser: ${singleLine(decision.reason, 1000)}`,
    ``,
    `Follow instructions from the organiser and official sources (NEA, venue staff) for your safety.`,
    ``,
    `--`,
    `You are receiving this because you joined updates for this event through RainReady.`,
    `Unsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}`,
  ].join("\n");
  return { subject: `[RainReady${demo ? " DEMO" : ""}] ${subject}`.slice(0, 200), body };
}

export const renderBody = (body, publicUrl, token) => body.split(UNSUBSCRIBE_PLACEHOLDER).join(unsubscribeUrl(publicUrl, token));

/**
 * Creates the notification for a confirmed decision and sends it, a few emails at a time.
 * Returns { notification, duplicate } or { skipped: reason }.
 */
export async function notifyParticipants({ store, mailer, organizationId, organizationName, event, decision, userId = null, concurrency = 4, publicUrl = mailer.publicUrl, demo = false }) {
  if (!NOTIFY_ACTIONS.includes(decision.action)) return { skipped: "action_not_notified" };
  const recipients = await store.participants.recipients(organizationId, event.id);
  if (!recipients.length) return { skipped: "no_participants" };
  if (recipients.length > MAX_RECIPIENTS) return { skipped: "too_many_participants" };
  const { subject, body } = composeDecisionEmail({ event, decision, organizationName, demo });
  const now = new Date().toISOString();
  const created = await store.notifications.create(organizationId, {
    eventId: event.id, decisionId: decision.id, action: decision.action, subject, body, mailer: mailer.name, createdByUserId: userId, recipients, now,
  });
  if (created.error) return { skipped: created.error };
  if (created.duplicate) return { notification: created.notification, duplicate: true, recent: Boolean(created.recent) };
  const queue = [...created.deliveries];
  const worker = async () => {
    while (queue.length) {
      const delivery = queue.shift();
      const link = `${publicUrl}/unsubscribe/${encodeURIComponent(delivery.unsubscribeToken)}`;
      let outcome;
      try {
        const result = await mailer.send({ to: delivery.email, subject, text: renderBody(body, publicUrl, delivery.unsubscribeToken), unsubscribeUrl: link });
        outcome = { status: "sent", providerMessageId: result?.messageId ?? null, sentAt: new Date().toISOString() };
      } catch (error) {
        console.error("RainReady could not send a participant email:", error.message);
        outcome = { status: "failed", error: String(error.message ?? error).slice(0, 300) };
      }
      // A failure to record the outcome must not stop the other emails; the row stays "pending".
      await store.notifications.markDelivery(organizationId, delivery.id, outcome)
        .catch((error) => console.error("RainReady could not record an email delivery:", error.message));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { notification: await store.notifications.finish(organizationId, created.notification.id, new Date().toISOString()), duplicate: false };
}
