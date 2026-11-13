/**
 * Calling Claude with a tool we need it to use. Older models accept a forced tool_choice; newer ones
 * (with built-in thinking) reject it with a 400. Then we ask with tool_choice "auto" and an explicit
 * instruction to call the tool — and remember that for the model so later calls go straight there.
 */
type Client = { messages: { create: (args: any) => Promise<{ content: { type: string; [k: string]: unknown }[] }> } };

const noForcedTools = new Set<string>();

export const isForcedToolRejection = (err: any) => err?.status === 400 && /tool_choice/i.test(String(err?.message ?? err?.error?.error?.message ?? ''));

export async function createWithTool(client: Client, args: { model: string; system: string; tools: { name: string }[]; tool_choice: { type: 'tool'; name: string } | { type: 'any' }; [k: string]: unknown }) {
  const toolNames = args.tools.map((t) => t.name).join(' or ');
  const relaxed = () => ({ ...args, tool_choice: { type: 'auto' }, system: `${args.system}\n\nAlways answer by calling the ${toolNames} tool, exactly once. Do not reply with plain text.` });
  if (noForcedTools.has(args.model)) return client.messages.create(relaxed());
  try {
    return await client.messages.create(args);
  } catch (err) {
    if (!isForcedToolRejection(err)) throw err;
    noForcedTools.add(args.model);
    return client.messages.create(relaxed());
  }
}
