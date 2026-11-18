import { Fragment, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ROUTE_IDS, type RouteId } from '@queuebridge/contracts';

/**
 * Renders a knowledge-base body (Safe Markdown, design §11.2) as React elements: headings,
 * numbered and bulleted lists, paragraphs, `**strong**`, `_emphasis_` and `[text](route:<id>)`
 * links. It never produces HTML from text (no `dangerouslySetInnerHTML`), so even a tampered
 * cached body renders as inert text. A route link becomes a link only when `pathFor` returns a
 * path (registered, linkable and permitted for this user here); otherwise its text is shown
 * without a link.
 */

const ROUTE_SET: ReadonlySet<string> = new Set(ROUTE_IDS);
const INLINE = /\*\*([^*\n]+)\*\*|_([^_\n]+)_|\[([^\]\n]{1,120})\]\(route:([a-z_.]+)\)/g;

function inline(
  text: string,
  pathFor: (id: RouteId) => string | null,
  onNavigate: () => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) out.push(<strong key={key++}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key++}>{m[2]}</em>);
    else {
      const label = m[3] ?? '';
      const id = m[4] ?? '';
      const path = ROUTE_SET.has(id) ? pathFor(id as RouteId) : null;
      out.push(
        path ? (
          <Link key={key++} to={path} onClick={onNavigate}>
            {label}
          </Link>
        ) : (
          <Fragment key={key++}>{label}</Fragment>
        ),
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'ol' | 'ul'; items: string[] }
  | { kind: 'p'; text: string };

export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', text: h[1] ?? '' });
    } else if (ol || ul) {
      flush();
      const kind = ol ? 'ol' : 'ul';
      const item = (ol ?? ul)?.[1] ?? '';
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === kind) prev.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

export function SafeArticle({
  body,
  pathFor,
  onNavigate = () => undefined,
}: {
  body: string;
  pathFor: (id: RouteId) => string | null;
  onNavigate?: () => void;
}): ReactElement {
  return (
    <div className="que-article-body">
      {parseBlocks(body).map((b, i) => {
        if (b.kind === 'heading') return <h4 key={i}>{inline(b.text, pathFor, onNavigate)}</h4>;
        if (b.kind === 'p') return <p key={i}>{inline(b.text, pathFor, onNavigate)}</p>;
        const items = b.items.map((t, j) => <li key={j}>{inline(t, pathFor, onNavigate)}</li>);
        return b.kind === 'ol' ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      })}
    </div>
  );
}
