import { createHash } from 'node:crypto'

// CanvasKit's registered Typeface path ignores the weight axis when making a
// Font. Use the editor's own weighted browser raster and measurement routines
// only for project font faces installed in both registries.
export function createProjectTextRenderer(lookUp, registeredCss, segments, drawText, measureText, ctx) {
  return {
    family(stack) {
      if (!ctx) return undefined
      const entry = lookUp(stack)
      return entry?.source === 'imported' ? registeredCss(entry.familyKey) : undefined
    },
    draw(t, css, x, y, size, weight, italic, r, g, b, a) {
      for (const part of segments(t)) {
        x += drawText(part.text, x, y, size, weight, italic, r, g, b, a, part.emoji, css)
      }
    },
    measure(t, css, size, weight, italic) {
      let width = 0
      for (const part of segments(t)) width += measureText(part.text, size, weight, italic, css)
      return width
    },
  }
}

export function patchCompilerFontRenderer(source) {
  if (createHash('sha256').update(source).digest('hex') !==
      '355be50ea2d6cd02a49568dec989ff3d606f75b6450cd6744e1350471c645e12') {
    throw new Error('Unexpected managed OpenPencil CanvasKit renderer version')
  }
  function replace(anchor, replacement) {
    if (source.split(anchor).length !== 2) throw new Error('Unexpected managed OpenPencil text renderer')
    source = source.replace(anchor, () => replacement)
  }
  const registry = 'return opCkResolveRegisteredTypeface(family, importedTypefaces, systemTypefacesByFamily, bundledTypefaces);\n  };'
  replace(registry, registry + '\n  const projectText = (' + createProjectTextRenderer.toString() +
    ')(familyTypefaceEntry, projectCssFamily, segments, drawBrowserText, browserTextMeasure, browserTextCtx);')
  const draw = 'drawText(t, family, x, y, sz, weight, italic, r, g, b, a) {\n      if (!t) return;'
  replace(draw, draw + '\n      const css = projectText.family(family);' +
    '\n      if (css) return projectText.draw(t, css, x, y, sz, weight, italic, r, g, b, a);')
  const measure = 'measureTextFamilyStyled(t, family, sz, weight, italic) {'
  replace(measure, measure + '\n      const css = projectText.family(family);' +
    '\n      if (css) return projectText.measure(t, css, sz, weight, italic);')
  // Keep bidi / contextual scripts whole on their original shaping path.
  const shapedDraw = 'drawBrowserText(t, x, y, sz, weight, italic, r, g, b, a, false, family);'
  replace(shapedDraw, shapedDraw.replace('false, family', 'false, projectText.family(family) || family'))
  const shapedMeasure = 'return browserTextMeasure(t, sz, weight, italic, family);'
  replace(shapedMeasure, shapedMeasure.replace('italic, family', 'italic, projectText.family(family) || family'))
  const ascent = 'textAscent(family, sz, weight) {'
  replace(ascent, ascent + [
    '', '      const css = projectText.family(family);',
    '      if (css) {',
    "        browserTextCtx.font = browserTextFont(sz, weight, false, css);",
    "        const metrics = browserTextCtx.measureText('M');",
    '        return metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || sz * 0.8;',
    '      }',
  ].join('\n'))
  // Baseline alignment and paragraph wrapping must use the very same face as
  // drawText; preserve the native line-height, ascent and descent calculation.
  const first = 'const covSegs = familyEntry\n        ? registeredCoverageSegments(familyEntry.key, familyEntry.tf, sz, sample)'
  replace(first, first.replace('const covSegs = familyEntry','const css = projectText.family(family);\n      const covSegs = familyEntry && !css'))
  replace('browserTextCtx.font = browserTextFont(sz, weight, italic);',
    'browserTextCtx.font = browserTextFont(sz, weight, italic, css);')
  replace('browserTextFont(run.sz, run.weight, run.italic, run.family)',
    'browserTextFont(run.sz, run.weight, run.italic, projectText.family(run.family) || run.family)')
  const added = 'importedTypefaces.set(key, { tf, family: String(family || \'\') });'
  replace(added, added + '\n      noteFontRegistration(family);')
  const removed = 'importedTypefaces.delete(key);'
  replace(removed, removed + "\n      noteFontRegistration(family, 'remove');")
  return "import { projectCssFamily, noteFontRegistration } from '/pkg/uic-font-faces.mjs';\n" + source
}
