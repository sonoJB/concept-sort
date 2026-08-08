"use client";

/**
 * Renders a pre-built SVG string produced by src/lib/analysis/view/svgFigures.ts,
 * which XML-escapes every piece of text (statement numbers, researcher
 * labels) before it ever reaches this component. Only ever pass strings
 * from those builders here — never raw, unescaped user input directly.
 */
export function InlineSvg({ svg, ariaLabel }: { svg: string; ariaLabel: string }) {
  return <div role="img" aria-label={ariaLabel} className="w-full [&_svg]:w-full [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}
