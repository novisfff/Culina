import { Fragment, useState, type ReactNode } from 'react';

function CodeBlock({ className, children, ...props }: { className?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
  const codeString = String(children).replace(/\n$/, '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const isInline = !match && !codeString.includes('\n');

  if (isInline) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="ai-code-block-container">
      <div className="ai-code-block-header">
        <span className="ai-code-block-lang">{language || 'code'}</span>
        <button className="ai-code-block-copy-btn" onClick={handleCopy} type="button">
          {copied ? (
            <span className="copied-status">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px', display: 'inline-block', verticalAlign: 'middle' }}><polyline points="20 6 9 17 4 12"></polyline></svg>
              已复制
            </span>
          ) : (
            <span>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px', display: 'inline-block', verticalAlign: 'middle' }}><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              复制
            </span>
          )}
        </button>
      </div>
      <pre className="ai-code-block-pre">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

function inlineMarkdown(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|\[[^\]]+\]\([^\s)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith('`')) nodes.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('~~')) nodes.push(<del key={`${match.index}-del`}>{token.slice(2, -2)}</del>);
    else if (token.startsWith('*') || token.startsWith('_')) nodes.push(<em key={`${match.index}-em`}>{token.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(token);
      if (link && /^(https?:|mailto:)/.test(link[2])) nodes.push(<a key={`${match.index}-link`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>);
      else nodes.push(token);
    }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function renderMarkdownBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<CodeBlock key={`code-${index}`} className={language ? `language-${language}` : undefined}>{`${code.join('\n')}\n`}</CodeBlock>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const Tag = `h${heading[1].length}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={`heading-${index}`}>{inlineMarkdown(heading[2])}</Tag>);
      index += 1;
      continue;
    }
    if (/^[-*_]{3,}\s*$/.test(line)) { blocks.push(<hr key={`hr-${index}`} />); index += 1; continue; }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={`quote-${index}`}>{inlineMarkdown(quote.join('\n'))}</blockquote>);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = ordered ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]) : /^\s*[-*+]\s+(.+)$/.exec(lines[index]);
        if (!item) break;
        items.push(<li key={`li-${index}`}>{inlineMarkdown(item[1])}</li>);
        index += 1;
      }
      blocks.push(ordered ? <ol key={`ol-${index}`}>{items}</ol> : <ul key={`ul-${index}`}>{items}</ul>);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s|^```|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^>\s?/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={`p-${index}`}>{inlineMarkdown(paragraph.join('\n'))}</p>);
  }
  return blocks;
}

export default function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="ai-message-markdown">
      {renderMarkdownBlocks(text).map((node, index) => <Fragment key={index}>{node}</Fragment>)}
    </div>
  );
}
