import { Fragment, type ReactNode } from 'react';

/** Translated text with {placeholders} filled by elements (e.g. a bold email address). */
export function Rich({ text, values }: { text: string; values: Record<string, ReactNode> }) {
  const parts = text.split(/(\{\w+\})/);
  return <>{parts.map((p, i) => { const m = /^\{(\w+)\}$/.exec(p); return <Fragment key={i}>{m && m[1] in values ? values[m[1]] : p}</Fragment>; })}</>;
}
