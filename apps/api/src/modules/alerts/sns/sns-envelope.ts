import { z } from 'zod';
import { normalizeAlertTime } from '../alert-time.js';
import { AlertInputError } from '../alert.types.js';

const fields = {
  Message: z.string().max(256 * 1024), MessageId: z.string().min(1).max(128),
  Timestamp: z.string().max(64), TopicArn: z.string().min(1).max(256),
  SignatureVersion: z.enum(['1', '2']), Signature: z.string().min(1).max(4096),
  SigningCertURL: z.string().min(1).max(2048),
};
const schema = z.discriminatedUnion('Type', [
  z.object({ ...fields, Type: z.literal('Notification'), Subject: z.string().max(256).optional(), UnsubscribeURL: z.string().max(2048).optional() }).strict(),
  z.object({ ...fields, Type: z.literal('SubscriptionConfirmation'), Token: z.string().min(1).max(8192), SubscribeURL: z.string().min(1).max(8192) }).strict(),
  z.object({ ...fields, Type: z.literal('UnsubscribeConfirmation'), Token: z.string().min(1).max(8192), SubscribeURL: z.string().min(1).max(8192) }).strict(),
]);
export type SnsEnvelope = z.infer<typeof schema>;
declare const verifiedEnvelope: unique symbol;
export type VerifiedSnsEnvelope = SnsEnvelope & { readonly [verifiedEnvelope]: true };
export function parseSnsEnvelope(input: unknown): SnsEnvelope {
  try {
    const result = schema.parse(input);
    if (Buffer.byteLength(result.Message, 'utf8') > 256 * 1024) throw new AlertInputError();
    normalizeAlertTime(result.Timestamp);
    return result;
  } catch { throw new AlertInputError(); }
}
export function buildSnsSigningString(envelope: SnsEnvelope): string {
  const fields = envelope.Type === 'Notification'
    ? ['Message', 'MessageId', ...(Object.hasOwn(envelope, 'Subject') ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const values = envelope as Record<string, unknown>;
  return fields.map((field) => `${field}\n${String(values[field])}\n`).join('');
}
