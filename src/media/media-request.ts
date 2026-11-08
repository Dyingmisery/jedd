/**
 * A message that is only a number, resolved against the stored list.
 * Anything else returns null and the model still sees the turn.
 */

import { resolveOfKind } from '../choices.js';
import type { Tool, ToolContext } from '../tools/types.js';

export async function replyToNumericMediaChoice(
  text: string,
  ctx: ToolContext,
  tools: { addMovie?: Tool; addSeries?: Tool },
): Promise<string | null> {
  const match = /^\s*(\d+)\s*$/.exec(text);
  if (!match || !ctx.choices) return null;
  const n = Number(match[1]);
  const resolved = resolveOfKind(ctx.choices, ctx.senderHandle, n, 'media-choice');
  if (!resolved.ok) {
    if (resolved.reason === 'expired') return 'That list has expired. Please ask again.';
    if (resolved.reason === 'out-of-range') return 'That number is not on the list. Nothing was added.';
    return null;
  }
  const value = resolved.option.value as {
    arr?: string;
    id?: number;
    title?: string;
    year?: number;
  };
  const title = String(value.title ?? '').trim();
  const year = Number(value.year) > 0 ? Number(value.year) : undefined;
  const id = Number(value.id);
  if ((value.arr !== 'movie' && value.arr !== 'series') || !title || !Number.isFinite(id) || id <= 0) {
    return 'That number is not on the list. Nothing was added.';
  }
  if (value.arr === 'series') {
    ctx.choices.present({
      senderHandle: ctx.senderHandle,
      subject: title,
      kind: 'media-choice',
      options: [{ n: 1, label: resolved.option.label, value: resolved.option.value }],
    });
    const when = year ? ` (${year})` : '';
    return `Which seasons of ${title}${when} should I add?`;
  }
  if (!tools.addMovie) return 'I could not add that movie.';
  const result = await tools.addMovie.run(
    { tmdb_id: id, title, choice: n, ...(year ? { year } : {}) },
    ctx,
  );
  return result.verbatimReply ?? result.content;
}
