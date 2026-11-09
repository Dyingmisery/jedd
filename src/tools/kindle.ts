import { mayRequestKindle, sameHandle } from '../permissions.js';
import { fail, ok, type Tool } from './types.js';

/**
 * Storing someone's Kindle delivery address.
 *
 * 🔴 THIS TOOL ACCEPTS AN ADDRESS AND USUALLY REFUSES IT.
 *
 * That is the design, not a limitation. V1's model **fabricated an address and a
 * stranger received someone's book** — `someone@kindle.com`, which is Jeff's
 * real address with the middle of the local part removed, persisted for a
 * different user who had never typed one.
 *
 * A validator would have accepted it: it is a syntactically perfect
 * `@kindle.com` address. **No property of the string separates a real address
 * from a plausible fabrication**, so the check cannot be on the string. It is on
 * PROVENANCE — the value must appear verbatim in this sender's own messages.
 *
 * ⚠️ There is deliberately **no `send_ebook` tool yet.** The delivery pipeline
 * (Prowlarr → qBittorrent → SMTP) does not exist, and shipping a send tool that
 * cannot send would be the `request_media` mistake again: a tool that implies a
 * capability it does not have. When it lands, **it will take no address
 * parameter at all** — the address comes from this store, keyed by the handle
 * the message arrived on, so the model cannot supply what the schema will not
 * accept.
 */
export const saveKindleEmail: Tool = {
  name: 'save_kindle_email',
  description:
    'Store the Kindle delivery address someone has given you, so books can be sent to them later. ' +
    'Pass the address EXACTLY as they typed it. If they have not typed one in this conversation, ' +
    'ask them for it — do not reconstruct it from anything else, and do not offer a guess.',
  minRole: 'guest',
  writes: true,
  parameters: {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        description: 'The @kindle.com address, exactly as this person typed it.',
      },
    },
    required: ['address'],
  },
  async run(args, ctx) {
    const raw = typeof args['address'] === 'string' ? args['address'] : '';
    if (!raw.trim()) return fail('No address supplied.');
    if (!ctx.kindle) return fail('No address store is available, so nothing was saved.');
    if (ctx.config.readOnly) return fail('Writes are disabled, so nothing was saved.');
    if (!sameHandle(ctx.senderHandle, ctx.config.ownerHandle)) {
      return fail('REFUSED — this sender cannot set the Kindle address. Nothing was saved.');
    }

    const result = ctx.kindle.save(ctx.senderHandle, raw, ctx.userTurns ?? []);
    if (!result.ok) return fail(result.reason);

    return ok(
      `SAVED — ${result.record.address} is stored for this person, taken from their own message. ` +
        `Remind them once that they must add ${ctx.config.kindle.fromEmail} to their Amazon ` +
        'approved-senders list, or delivery will silently fail on Amazon’s side.',
    );
  },
};

/** What we hold for this person, if anything. Read-only, so guests may ask. */
export const kindleStatus: Tool = {
  name: 'kindle_status',
  description:
    'Check whether a Kindle delivery address is already stored for the person you are talking to. ' +
    'Use this before asking them for one, so you do not ask twice.',
  minRole: 'guest',
  writes: false,
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    if (!ctx.kindle) return fail('No address store is available.');
    if (!sameHandle(ctx.senderHandle, ctx.config.ownerHandle)) {
      if (!mayRequestKindle(ctx.senderHandle, ctx.config)) {
        return fail('REFUSED — ebook sending is not enabled for this sender.');
      }
      return ok('CONFIGURED — books go to the household Kindle address. This sender cannot change it.');
    }
    const rec = ctx.kindle.get(ctx.senderHandle);
    return rec
      ? ok(`STORED — ${rec.address} (saved ${rec.at.slice(0, 10)}).`)
      : ok('NONE — no Kindle address is stored for this person. Ask them to send it themselves.');
  },
};
