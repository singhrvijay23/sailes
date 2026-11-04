/**
 * Chat with a store from the terminal, without the widget.
 *   pnpm --filter @sailes/api exec tsx src/scripts/try-chat.ts pk_demo_wellness "hi" "protein under $40" "vanilla"
 * Each argument after the key is one shopper message in the same conversation.
 */
import { handleChat } from '../agent/orchestrator.js';
import { pool, query } from '../db/pool.js';

const [key, ...messages] = process.argv.slice(2);
const row = (await query('SELECT tenant_id FROM widget_keys WHERE key = $1', [key])).rows[0];
if (!row) throw new Error(`Unknown widget key ${key}`);

let conversationId: string | null = null;
for (const message of messages) {
  let text = '';
  const extras: string[] = [];
  const out = await handleChat({
    tenantId: row.tenant_id,
    conversationId,
    message,
    emit: (event, data: any) => {
      if (event === 'text') text += data.delta;
      else if (event === 'products') for (const p of data.items) extras.push(`  [card] ${p.id} ${p.title} $${p.price} | ${p.reason}`);
      else if (event === 'question') extras.push(`  [chips] ${data.options.join(' / ')}`);
      else if (event === 'reset') text = '';
    },
  });
  conversationId = out.conversationId;
  console.log(`\nSHOPPER: ${message}\nSAILES (${out.mode}): ${text}`);
  for (const e of extras) console.log(e);
}
await pool.end();
