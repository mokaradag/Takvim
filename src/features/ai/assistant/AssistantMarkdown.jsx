'use client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../../components/icons';
import { copyTextToClipboard } from './assistantInteraction.js';
import { createAssistantMarkdownParser } from './assistantMarkdown.js';

/**
 * Rota AI yanıtının çizimi. Ağaç `assistantMarkdown.js` tarafından üretilir;
 * burada yalnızca React öğelerine çevrilir. Metin her zaman kaçışlı metin
 * düğümüdür, HTML enjekte edilmez. Bağlantılar yeni sekmede, yönlendiren
 * bilgisi gönderilmeden açılır ve hedef adres başlıkta görünür (yanıltıcı
 * bağlantı metnine karşı). Görsel yüklenmez; görsel bağlantısı açıkça
 * "Görsel:" önekiyle gösterilir.
 */

const HEADING_TAGS = { 1: 'h3', 2: 'h3', 3: 'h4' };

function CodeBlock({ language, text }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const copy = async () => {
    const ok = await copyTextToClipboard(text);
    setCopied(ok);
    clearTimeout(timerRef.current);
    if (ok) timerRef.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <figure className="assistant-md-code">
      <figcaption className="assistant-md-code-head">
        <span>{language || 'kod'}</span>
        <button type="button" className="assistant-md-code-copy" onClick={copy} aria-label={copied ? 'Kod kopyalandı' : 'Kodu kopyala'}>
          {copied ? <Icons.Check size={12} aria-hidden="true" /> : <Icons.Copy size={12} aria-hidden="true" />}
          <span>{copied ? 'Kopyalandı' : 'Kopyala'}</span>
        </button>
      </figcaption>
      <pre tabIndex={0}><code>{text}</code></pre>
    </figure>
  );
}

/** Satır içi düğümler → React öğeleri. */
export function renderInline(nodes = [], keyPrefix = 'i') {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case 'text':
        return node.value;
      case 'break':
        return <br key={key} />;
      case 'code':
        return <code key={key} className="assistant-md-inline-code">{node.value}</code>;
      case 'strong':
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'del':
        return <del key={key}>{renderInline(node.children, key)}</del>;
      case 'link':
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" title={node.href}>
            {node.image ? 'Görsel: ' : null}
            {renderInline(node.children, key)}
          </a>
        );
      case 'group':
        return <span key={key}>{renderInline(node.children, key)}</span>;
      default:
        return null;
    }
  });
}

/** Blok düğümü → React öğesi. */
export function renderBlock(block, key = 'b') {
  switch (block.type) {
    case 'paragraph':
      return <p key={key}>{renderInline(block.children, key)}</p>;
    case 'heading': {
      const Tag = HEADING_TAGS[block.level] || 'h5';
      return <Tag key={key} className="assistant-md-heading">{renderInline(block.children, key)}</Tag>;
    }
    case 'code':
      return <CodeBlock key={key} language={block.language} text={block.text} />;
    case 'rule':
      return <hr key={key} />;
    case 'quote':
      return <blockquote key={key}>{block.children.map((child, index) => renderBlock(child, `${key}-${index}`))}</blockquote>;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag key={key} className={`assistant-md-list${block.tight ? ' is-tight' : ''}`} start={block.ordered && block.start !== 1 ? block.start : undefined}>
          {block.items.map((item, index) => (
            <li key={`${key}-${index}`}>{item.map((child, childIndex) => renderBlock(child, `${key}-${index}-${childIndex}`))}</li>
          ))}
        </Tag>
      );
    }
    case 'table':
      return (
        <div key={key} className="assistant-md-table" tabIndex={0} role="group" aria-label="Tablo">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} scope="col" className={block.align[index] ? `is-${block.align[index]}` : undefined}>{renderInline(cell, `${key}-h${index}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} className={block.align[index] ? `is-${block.align[index]}` : undefined}>{renderInline(cell, `${key}-${rowIndex}-${index}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

/**
 * Üst düzey blok; kaynak metni değişmediyse yeniden çizilmez. Akış sürerken
 * yalnızca büyüyen son blok yeniden çizilir, önceki paragraflar ve kod
 * blokları sabit kalır.
 */
const MarkdownBlock = memo(
  function MarkdownBlock({ block, blockKey }) {
    return renderBlock(block, blockKey);
  },
  (previous, next) => previous.blockKey === next.blockKey && previous.block.source === next.block.source
);

export function AssistantMarkdown({ text }) {
  const parse = useMemo(() => createAssistantMarkdownParser(), []);
  const blocks = useMemo(() => parse(text), [parse, text]);
  return (
    <div className="assistant-md">
      {blocks.map((block, index) => <MarkdownBlock key={index} blockKey={`b${index}`} block={block} />)}
    </div>
  );
}
