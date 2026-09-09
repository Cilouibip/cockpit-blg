import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const opaque = z.string().uuid();
const adId = z.string().regex(/^\d{1,30}$/);
const common = {
  event_id: opaque, schema_version: z.literal(1), occurred_at: z.string().datetime({ offset: true }),
  anonymous_id: opaque, session_id: opaque, journey_id: opaque,
  tunnel: z.enum(['quiz', 'masterclass']), link_revision_id: opaque.nullable(),
  ad_id: adId.optional(), adset_id: adId.optional(), campaign_id: adId.optional(),
  page_version: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
};
const emptyProperties = z.object({}).strict();
const event = <T extends string, P extends z.ZodType>(name: T, properties: P) => z.object({ ...common, event_name: z.literal(name), properties }).strict();
const question = z.object({ question_number: z.number().int().min(1).max(12) }).strict();
export const browserEventSchema = z.discriminatedUnion('event_name', [
  event('landing_arrival', emptyProperties), event('page_view', emptyProperties),
  event('quiz_started', emptyProperties), event('quiz_question_viewed', question), event('quiz_question_answered', question),
  event('quiz_completed', z.object({ answered_count: z.literal(12) }).strict()),
  event('lead_form_viewed', z.object({ answered_count: z.literal(12) }).strict()),
  event('lead_form_submitted', emptyProperties), event('result_viewed', emptyProperties),
  event('masterclass_optin_submitted', emptyProperties), event('video_started', z.object({ video_id: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/), video_version: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/), playback_id: opaque }).strict()),
  event('video_watch', z.object({
    video_id: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/), video_version: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/), playback_id: opaque, duration: z.number().positive().max(86400),
    intervals: z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive() }).strict()).min(1).max(30),
  }).strict()),
  event('bilan_clicked', emptyProperties),
]).superRefine((value, context) => {
  if (value.event_name === 'video_watch') {
    for (const [index, interval] of value.properties.intervals.entries()) {
      if (interval.end <= interval.start || interval.end > value.properties.duration || interval.end - interval.start > 30) context.addIssue({ code: 'custom', path: ['properties', 'intervals', index], message: 'Invalid played interval' });
    }
  }
  const quizEvents = ['quiz_started', 'quiz_question_viewed', 'quiz_question_answered', 'quiz_completed', 'lead_form_viewed', 'lead_form_submitted', 'result_viewed'];
  if ((quizEvents.includes(value.event_name) && value.tunnel !== 'quiz') || ((value.event_name.startsWith('video_') || value.event_name === 'masterclass_optin_submitted') && value.tunnel !== 'masterclass')) context.addIssue({ code: 'custom', path: ['tunnel'], message: 'Event and tunnel mismatch' });
});
export type BrowserEvent = z.infer<typeof browserEventSchema>;

/** This contract is accepted only by the signed server route after the source saved a registration. */
export const serverLeadSchema = z.object({
  event_id: opaque, schema_version: z.literal(1), event_name: z.literal('lead_registered'),
  registered_at: z.string().datetime({ offset: true }), tunnel: z.enum(['quiz', 'masterclass']),
  source: z.enum(['wix', 'first_party']), source_account_id: z.string().min(1).max(100),
  external_id: z.string().regex(/^[a-zA-Z0-9._:-]{1,150}$/),
  journey_id: opaque, anonymous_id: opaque, session_id: opaque, link_revision_id: opaque.nullable(),
  identity: z.object({ namespace: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/), external_id: z.string().regex(/^[a-zA-Z0-9._:-]{1,150}$/), email: z.string().email().max(254).optional() }).strict(),
}).strict();
export type ServerLead = z.infer<typeof serverLeadSchema>;

export function signIngestion(body: string, timestampSeconds: string, secret: string): string {
  if (secret.length < 32) throw new Error('INGESTION_SECRET_TOO_SHORT');
  return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
}

/** Timestamp bounds replay age; event_id/source IDs must additionally be unique in storage. */
export function verifyIngestionSignature(body: string, timestampSeconds: string | null, signature: string | null, secret: string, nowMs = Date.now()): boolean {
  if (!timestampSeconds || !/^\d{10}$/.test(timestampSeconds) || !signature || !/^[a-f0-9]{64}$/.test(signature) || secret.length < 32 || Math.abs(nowMs - Number(timestampSeconds) * 1000) > 300_000) return false;
  const expected = Buffer.from(signIngestion(body, timestampSeconds, secret), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function validateEventClock(occurredAt: string, nowMs = Date.now(), maxAgeMs = 86_400_000): boolean {
  const instant = Date.parse(occurredAt);
  return Number.isFinite(instant) && instant >= nowMs - maxAgeMs && instant <= nowMs + 300_000;
}
