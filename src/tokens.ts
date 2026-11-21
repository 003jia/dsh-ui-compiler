import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const themePackage = '@deepseek-ai/dsh-client-ui-theme';
const themeVersion = '0.2.2-alpha.2';
const extension = 'dev.uic';
const body = 'body';
const darkBody = 'body[data-ds-dark-theme]';
const macBody = 'html[data-platform=darwin] body';
const macDarkBody = 'html[data-platform=darwin] body[data-ds-dark-theme]';

type Declaration = { cssValue: string; selector: string };
type Declarations = Map<string, Declaration>;
type Color = {
  colorSpace: 'srgb';
  components: [number, number, number];
  alpha: number;
};
type Dimension = { value: number; unit: 'px' | 'rem' };
type TypedValue = { type: 'color'; value: Color } | { type: 'dimension'; value: Dimension };

function readInlineCss(bundle: string, name: string): string {
  const pattern = new RegExp(`\\bvar\\s+${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*");`);
  const literal = bundle.match(pattern)?.[1];
  if (!literal) throw new Error(`Unable to locate ${name} in ${themePackage} ${themeVersion}`);
  return JSON.parse(literal) as string;
}

function readThemeCss(projectRoot: string, cssPath?: string) {
  if (cssPath) {
    const path = resolve(projectRoot, cssPath);
    return { source: basename(path), css: readFileSync(path, 'utf8') };
  }
  const directory = join(projectRoot, 'node_modules', themePackage);
  let manifest: { version?: string };
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${themePackage}@${themeVersion}; install dependencies or supply CSS`, {
      cause: error,
    });
  }
  if (manifest.version !== themeVersion) {
    throw new Error(`Expected ${themePackage}@${themeVersion}; found ${manifest.version ?? 'no version'}`);
  }
  const bundle = readFileSync(join(directory, 'lib', 'client.js'), 'utf8');
  return {
    source: `${themePackage}@${themeVersion}/lib/client.js (base.css, design-platform.css)`,
    css: [
      readInlineCss(bundle, 'base_css_default'),
      readInlineCss(bundle, 'design_platform_css_default'),
    ].join('\n'),
  };
}

function readDeclarations(css: string): Map<string, Declarations> {
  const normalized = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bySelector = new Map<string, Declarations>(
    [':root', body, darkBody, macBody, macDarkBody].map(selector => [selector, new Map()]),
  );
  let depth = 0;
  let selector = '';
  let start = 0;
  for (const boundary of normalized.matchAll(/([^{}]*)\{|\}/g)) {
    if (boundary[1] !== undefined) {
      if (depth === 0) {
        selector = boundary[1].trim()
          .replace(/\[data-platform=['"]darwin['"]\]/g, '[data-platform=darwin]')
          .replace(/\s+/g, ' ');
        start = boundary.index + boundary[0].length;
      }
      depth++;
      continue;
    }
    depth--;
    if (depth !== 0) continue;
    const declarations = bySelector.get(selector);
    if (!declarations) continue;
    const content = normalized.slice(start, boundary.index);
    for (const [, name, value] of content.matchAll(/(?:^|;)\s*(--dsw-[\w-]+)\s*:\s*([^;]+)(?=;|$)/g)) {
      declarations.set(name, { cssValue: value.trim(), selector });
    }
  }
  if (depth !== 0) throw new Error('Unbalanced braces in theme CSS');
  return bySelector;
}

const directAlias = /^var\(\s*(--dsw-[\w-]+)\s*\)$/;
const numberOrPercentage = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)%?$/;

function toColor(red: number, green: number, blue: number, alpha = 1): Color {
  return { colorSpace: 'srgb', components: [red, green, blue], alpha };
}

function proportion(part: string, fullScale: number): number {
  const ratio = part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part) / fullScale;
  return Math.min(1, Math.max(0, ratio));
}

function readColor(value: string): Color | undefined {
  if (value === 'transparent') return toColor(0, 0, 0, 0);
  if (value === 'white') return toColor(1, 1, 1);
  if (value === 'black') return toColor(0, 0, 0);
  const hex = value.match(/^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    const digits = hex.length < 5 ? [...hex].map(digit => digit.repeat(2)).join('') : hex;
    const [red, green, blue, alpha] = digits.match(/../g)!.map(pair => parseInt(pair, 16) / 255);
    return toColor(red, green, blue, alpha);
  }
  const rgb = value.match(/^rgba?\(\s*(.*?)\s*\)$/)?.[1];
  if (!rgb) return;
  const parts = rgb.split(/\s*[,/]\s*|\s+/);
  if ((parts.length !== 3 && parts.length !== 4) || !parts.every(part => numberOrPercentage.test(part))) return;
  const [red, green, blue, alpha] = parts;
  return toColor(proportion(red, 255), proportion(green, 255), proportion(blue, 255),
    alpha === undefined ? 1 : proportion(alpha, 1));
}

function readColorMix(value: string, resolveColor: (value: string) => Color | undefined): Color | undefined {
  // The pinned DSH stylesheet mixes two sRGB colors with an optional percentage.
  const match = value.match(/^color-mix\(\s*in srgb\s*,\s*(.*?)\s*,\s*(.*?)\s*\)$/);
  if (!match) return;
  const [left, right] = match.slice(1).map(stop => {
    const amount = stop.match(/\s+([\d.]+)%$/);
    return {
      color: resolveColor(amount ? stop.slice(0, amount.index) : stop),
      weight: amount ? Number(amount[1]) / 100 : undefined,
    };
  });
  if (!left.color || !right.color) return;
  const a = left.weight ?? (right.weight === undefined ? 0.5 : 1 - right.weight);
  const b = right.weight ?? (left.weight === undefined ? 0.5 : 1 - left.weight);
  if (a < 0 || b < 0 || a + b === 0) return;
  const leftAlpha = left.color.alpha * a;
  const rightAlpha = right.color.alpha * b;
  const totalAlpha = leftAlpha + rightAlpha;
  const components = left.color.components.map((component, index) =>
    totalAlpha === 0 ? 0 : (component * leftAlpha + right.color!.components[index] * rightAlpha) / totalAlpha,
  ) as Color['components'];
  return { colorSpace: 'srgb', components, alpha: totalAlpha / Math.max(1, a + b) };
}

function describeMode(mode: 'light' | 'dark', declarations: Declarations, macOverrides: Declarations) {
  const values = new Map<string, TypedValue | undefined>();
  const resolving = new Set<string>();
  function resolveValue(name: string): TypedValue | undefined {
    if (values.has(name)) return values.get(name);
    if (resolving.has(name)) throw new Error(`Circular theme token alias in ${mode}: ${name}`);
    const declaration = declarations.get(name);
    if (!declaration) return;
    resolving.add(name);
    const parsed = parseValue(declaration.cssValue);
    values.set(name, parsed);
    resolving.delete(name);
    return parsed;
  }
  function parseValue(value: string): TypedValue | undefined {
    const target = value.match(directAlias)?.[1];
    if (target) return resolveValue(target);
    const color = readColor(value) ?? readColorMix(value, stop => {
      const parsed = parseValue(stop);
      return parsed?.type === 'color' ? parsed.value : undefined;
    });
    if (color) return { type: 'color', value: color };
    const dimension = value.match(/^([-+]?(?:\d+(?:\.\d*)?|\.\d+))(px|rem)$/);
    if (dimension) return {
      type: 'dimension',
      value: { value: Number(dimension[1]), unit: dimension[2] as Dimension['unit'] },
    };
  }

  const cssOnly: Record<string, Declaration> = {};
  const tokens = Object.fromEntries([...declarations.keys()].sort().flatMap(name => {
    const declared = declarations.get(name)!;
    const value = resolveValue(name);
    if (!value) {
      cssOnly[name] = declared;
      return [];
    }
    const target = declared.cssValue.match(directAlias)?.[1];
    const darwinOverride = macOverrides.get(name);
    return [[name, {
      $type: value.type,
      $value: target ? `{${mode}.${target}}` : value.value,
      $extensions: {
        [extension]: { cssProperty: name, ...declared, ...(darwinOverride ? { darwinOverride } : {}) },
      },
    }]];
  }));
  return { tokens, cssOnly };
}

export function generateTokens(projectRoot: string, cssPath?: string) {
  const { source, css } = readThemeCss(projectRoot, cssPath);
  const bySelector = readDeclarations(css);
  // Body declarations beat inherited :root declarations; dark overrides have
  // higher specificity than body and the last declaration in each layer wins.
  const base = new Map([...bySelector.get(':root')!, ...bySelector.get(body)!]);
  const dark = new Map([...base, ...bySelector.get(darkBody)!]);
  const macLight = bySelector.get(macBody)!;
  const macDark = new Map([...macLight, ...bySelector.get(macDarkBody)!]);
  const lightResult = describeMode('light', base, macLight);
  const darkResult = describeMode('dark', dark, macDark);
  if (!Object.keys(lightResult.tokens).length || !Object.keys(darkResult.tokens).length) {
    throw new Error(`No supported --dsw-* color or dimension tokens found in ${source}`);
  }

  const document = {
    $description: 'DSH theme tokens. Light and dark groups follow the portable CSS cascade; Darwin overrides and non-portable CSS expressions are preserved in extensions.',
    $extensions: { [extension]: {
      source,
      cssOnly: { light: lightResult.cssOnly, dark: darkResult.cssOnly },
    } },
    light: lightResult.tokens,
    dark: darkResult.tokens,
  };
  const directory = join(projectRoot, 'tokens');
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.dsw.tokens.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, join(directory, 'dsw.tokens.json'));
  } finally {
    rmSync(temporary, { force: true });
  }
  return document;
}
