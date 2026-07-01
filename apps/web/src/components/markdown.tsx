'use client'

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { CodeBlock } from '@/components/code-block'
import { cn } from '@/lib/utils'

interface MarkdownProps {
  children: string
  className?: string
}

/**
 * 受控的 Markdown 渲染器。fenced code block 交给 CodeBlock（shiki 双主题高亮），
 * 其他元素直接用 Tailwind 贴合聊天泡泡。
 */
export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cn('text-sm leading-6 text-foreground', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mt-2 mb-1 text-lg font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-2 mb-1 text-base font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold">{children}</h3>,
          h4: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-semibold">{children}</h4>,
          p: ({ children }) => <p className="my-1.5 leading-6">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-6">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => {
            if (typeof src !== 'string' || !src) return null
            const altText = typeof alt === 'string' ? alt : undefined
            if (isBlockedGeneratedPlaceholderImage(src, altText)) {
              return (
                <span className="my-2 block rounded-md border border-dashed border-muted-foreground/30 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  截图未返回可显示的本地图片；请查看上方工具结果卡片。
                </span>
              )
            }
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={altText ?? ''}
                className="my-2 max-h-[70vh] max-w-full rounded-md border object-contain"
              />
            )
          },
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-muted" />,
          code: ({ className: codeClass, children }) => {
            const isBlock = codeClass?.startsWith('language-')
            if (isBlock) {
              const language = codeClass!.slice('language-'.length)
              return <CodeBlock code={String(children).replace(/\n$/, '')} language={language} />
            }
            return (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
                {children}
              </code>
            )
          },
          pre: ({ children }) => {
            // children 已经是 <CodeBlock />，pre 只透传，避免再套一层 <pre>。
            if (isCodeBlockChild(children)) return <>{children}</>
            return (
              <pre className="my-2 overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
                {children}
              </pre>
            )
          },
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-foreground/20 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-foreground/10 px-2 py-1 align-top">{children}</td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function isCodeBlockChild(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(isCodeBlockChild)
  if (!isValidElement(node)) return false
  const el = node as ReactElement<{ className?: string }>
  return el.type === CodeBlock || el.props?.className?.startsWith('language-') === true
}

function isBlockedGeneratedPlaceholderImage(src: string, alt?: string): boolean {
  const normalizedAlt = (alt ?? '').toLowerCase()
  const normalizedSrc = src.toLowerCase()
  if (
    /^(当前屏幕截图|桌面截图|screenshot|screen\s*capture|screenshot\s*captured)$/i.test(
      normalizedAlt.trim(),
    ) &&
    /^https?:\/\//.test(normalizedSrc)
  ) {
    return true
  }
  try {
    const host = new URL(src, globalThis.location?.origin).hostname.toLowerCase()
    return /(^|\.)placeholder\.(com|co)$/.test(host) || host === 'via.placeholder.com'
  } catch {
    return false
  }
}
