// Generates ios/Shared/Protocol.swift: Swift types, with their Codable, for everything the app and its core say to each
// other (ios/core/bridge.ts's FromApp and ToApp, and every type they hold: the website's protocol, the engine's views,
// commands and events, the web client's options and log lines), from the TypeScript types themselves, as the
// TypeScript compiler resolves them.
//
//   node ios/tools/swift-types/generate.ts            writes ios/Shared/Protocol.swift
//   node ios/tools/swift-types/generate.ts --check    fails if it isn't what the types make now
//
// How the TypeScript maps:
//   a union tagged by a field (`t`, `type`, `kind`, `mine`, `faceDown`...: in every member, a literal) is an enum with
//   a case per tag, its fields in a struct of its own (a member with no other fields: a plain case). Members that share
//   a tag are told apart by another field, as an enum nested in that case.
//   a union of string literals is a String enum; of number literals (seats) Int; other mixed unions (a seat or
//   'spectator'; 'all' or seats) an enum that tries each kind of value in turn.
//   number is Double (TypeScript can't tell an integer); string, boolean, arrays and string-keyed records as you'd think.
//   `x?: T` is an optional Swift field, left out when nil; `x: T | null` one that must be there, encoded as null; and
//   `x?: T | null` (three states: absent, null, a value) an optional Nullable<T>.
//   anything else becomes JSONValue, and is listed as a warning (none, as the types are now).
// TypeScript 5's compiler API (ios/tools/swift-types/package.json): TypeScript 7's isn't stable yet.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const IOS = join(here, '..', '..');
const OUT = join(IOS, 'Shared', 'Protocol.swift');
const ROOTS = ['FromApp', 'ToApp'];

const config = ts.getParsedCommandLineOfConfigFile(join(IOS, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } })!;
const program = ts.createProgram([join(IOS, 'core', 'bridge.ts')], { ...config.options, noEmit: true });
const checker = program.getTypeChecker();
const main = program.getSourceFile(join(IOS, 'core', 'bridge.ts'))!;
const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(main)!);

const warnings: string[] = [];
const declarations: string[] = [];
const named = new Map<string, string>(); // a type's identity → its Swift name
const used = new Set<string>(['JSONValue']);

// ---- names ----------------------------------------------------------------------------------------------------------

const KEYWORDS = new Set('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as Any catch false is nil super self Self throw throws true try Type Protocol'.split(' '));
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
const pascal = (s: string) => words(s).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('') || 'Value';
const camel = (s: string) => {
  const p = pascal(s);
  const c = p[0]!.toLowerCase() + p.slice(1);
  return /^[0-9]/.test(c) ? `_${c}` : c;
};
const ident = (s: string) => (KEYWORDS.has(s) ? `\`${s}\`` : s);
function unique(name: string): string {
  let n = name;
  for (let i = 2; used.has(n); i++) n = `${name}${i}`;
  used.add(n);
  return n;
}
// Generic helpers name nothing of their own: their instances are named where they're used.
const ANONYMOUS = new Set(['Omit', 'Pick', 'Partial', 'Record', 'Extract', 'Exclude', 'Readonly', 'ReadonlyArray', 'Array', 'NonNullable', 'PerSeat']);
function ownName(type: ts.Type): string | null {
  const alias = type.aliasSymbol?.getName();
  if (alias && !ANONYMOUS.has(alias)) return alias;
  const symbol = type.getSymbol()?.getName();
  if (symbol && !symbol.startsWith('__') && !ANONYMOUS.has(symbol)) return symbol;
  return null;
}
const typeKey = (type: ts.Type) => String((type as unknown as { id: number }).id);

/**
 * The name a field's declaration gives its type (`discard: CardId[]` → CardId), for types the compiler resolves to
 * something with no name of its own (CardId is (typeof CARD_IDS)[number]: a union of literals).
 */
function declaredName(p: ts.Symbol): string | null {
  let node = (p.valueDeclaration as ts.PropertySignature | undefined)?.type;
  for (;;) {
    if (!node) return null;
    if (ts.isArrayTypeNode(node)) node = node.elementType;
    else if (ts.isTypeOperatorNode(node) || ts.isParenthesizedTypeNode(node)) node = node.type;
    else if (ts.isUnionTypeNode(node)) {
      const real = node.types.filter((t) => !(t.kind === ts.SyntaxKind.LiteralType && (t as ts.LiteralTypeNode).literal.kind === ts.SyntaxKind.NullKeyword) && t.kind !== ts.SyntaxKind.UndefinedKeyword);
      if (real.length !== 1) return null;
      node = real[0];
    } else break;
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !ANONYMOUS.has(node.typeName.text) && node.typeArguments === undefined) return node.typeName.text;
  return null;
}

// ---- what a type is ---------------------------------------------------------------------------------------------------

const isNullish = (t: ts.Type) => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
const members = (t: ts.Type) => (t.isUnion() ? t.types : [t]);
const stringLiteral = (t: ts.Type) => (t.isStringLiteral() ? t.value : null);
const isBooleanish = (t: ts.Type) => (t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0;
const booleanValue = (t: ts.Type) => (t.flags & ts.TypeFlags.BooleanLiteral ? checker.typeToString(t) === 'true' : null);
const isObject = (t: ts.Type) => (t.flags & ts.TypeFlags.Object) !== 0 || t.isIntersection();
const isArray = (t: ts.Type) => checker.isArrayType(t) || checker.isTupleType(t);
const props = (t: ts.Type) => checker.getPropertiesOfType(t).filter((p) => !(p.flags & ts.SymbolFlags.Method));
const propType = (p: ts.Symbol) => checker.getTypeOfSymbol(p);
const optional = (p: ts.Symbol) => (p.flags & ts.SymbolFlags.Optional) !== 0;

/** A literal tag of `t`'s field `name`: its string or boolean value, or undefined if it has no single literal there. */
function tagOf(t: ts.Type, name: string): string | boolean | undefined {
  const p = t.getProperty(name);
  if (!p || optional(p)) return undefined;
  const pt = propType(p);
  const s = stringLiteral(pt);
  if (s !== null) return s;
  const b = booleanValue(pt);
  return b === null ? undefined : b;
}

/** The field telling union members apart: present in all, a literal in each; the most distinct values wins. */
function discriminant(ts_: readonly ts.Type[]): string | null {
  const names = new Set(ts_.flatMap((t) => props(t).map((p) => p.getName())));
  let best: { name: string; values: number } | null = null;
  for (const name of names) {
    const values = ts_.map((t) => tagOf(t, name));
    if (values.some((v) => v === undefined)) continue;
    const distinct = new Set(values).size;
    if (distinct < 2) continue;
    const rank = ['t', 'type', 'kind'].indexOf(name);
    if (!best || distinct > best.values || (distinct === best.values && rank >= 0)) best = { name, values: distinct };
  }
  return best?.name ?? null;
}

// ---- Swift for a type ---------------------------------------------------------------------------------------------------

/** The Swift type for `type` (null and undefined taken out: the caller makes the field optional). `hint`: a name for it if it needs one. */
function swift(type: ts.Type, hint: string, exclude: readonly string[] = [], preferred: string | null = null): string {
  const parts = members(type).filter((t) => !isNullish(t));
  if (parts.length === 0) return warn(type, hint, 'only null');
  // Booleans: `boolean` is the union true | false.
  if (parts.every(isBooleanish)) return 'Bool';
  if (parts.length > 1) return union(type, parts, hint, exclude, preferred);
  const t = parts[0]!;
  if (t.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) return 'String';
  if (t.flags & ts.TypeFlags.StringLiteral) return 'String'; // a lone literal that isn't a tag: kept as text
  if (t.flags & ts.TypeFlags.NumberLiteral) return 'Int';
  if (t.flags & ts.TypeFlags.Number) return 'Double';
  if (isArray(t)) {
    const elements = checker.getTypeArguments(t as ts.TypeReference);
    const element = checker.isTupleType(t) ? checker.getUnionType([...elements]) : elements[0]!;
    if (checker.isTupleType(t) && new Set(elements.map(typeKey)).size > 1 && !elements.every((e) => isObject(e) === isObject(elements[0]!))) return warn(t, hint, 'a tuple of mixed types');
    return `[${optionalElement(element, `${hint}Element`, preferred)}]`;
  }
  if (isObject(t)) {
    const index = t.getStringIndexType() ?? t.getNumberIndexType();
    if (index && props(t).length === 0) return `[String: ${optionalElement(index, `${hint}Value`)}]`;
    if (props(t).length > 0 && props(t).every((p) => /^[0-9]+$/.test(p.getName()))) {
      return `[String: ${optionalElement(checker.getUnionType(props(t).map(propType)), `${hint}Value`)}]`;
    }
    return struct(t, hint, exclude, preferred);
  }
  return warn(t, hint, `a ${checker.typeToString(t)}`);
}

/** An array's element or a record's value: optional in Swift if it can be null. */
function optionalElement(t: ts.Type, hint: string, preferred: string | null = null): string {
  const inner = swift(t, hint, [], preferred);
  return members(t).some(isNullish) ? `${inner}?` : inner;
}

function warn(t: ts.Type, hint: string, what: string): string {
  warnings.push(`${hint}: ${what} (${checker.typeToString(t)}) is JSONValue`);
  return 'JSONValue';
}

function union(type: ts.Type, parts: ts.Type[], hint: string, exclude: readonly string[], preferred: string | null): string {
  // String literals only: a String enum.
  if (parts.every((t) => stringLiteral(t) !== null)) {
    const name = ownName(type) ?? preferred ?? hint;
    const key = `strings:${parts.map(stringLiteral).sort().join('|')}`;
    if (named.has(key)) return named.get(key)!;
    const swiftName = unique(name);
    named.set(key, swiftName);
    const cases = parts.map((t) => stringLiteral(t)!).sort().map((v) => `  case ${ident(camel(v))} = ${JSON.stringify(v)}`);
    declarations.push(`public enum ${swiftName}: String, Codable, Equatable, Sendable, CaseIterable {\n${cases.join('\n')}\n}`);
    return swiftName;
  }
  // Strings of any shape (template literals: a table element's ref, `hand:${CardId}`): String.
  if (parts.every((t) => t.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.TemplateLiteral))) return 'String';
  // Number literals only (seats): Int.
  if (parts.every((t) => t.flags & ts.TypeFlags.NumberLiteral)) return 'Int';
  // Objects only: a tagged union.
  if (parts.every((t) => isObject(t) && !isArray(t))) {
    const tag = discriminant(parts);
    if (tag) return tagged(type, parts, tag, preferred ?? hint, exclude);
    if (parts.length === 1) return struct(parts[0]!, hint, exclude, preferred);
    return warn(type, hint, 'a union of objects with no tag');
  }
  return mixed(type, parts, preferred ?? hint);
}

/** A union tagged by `tag`: an enum, a case per value (members sharing one: told apart by another field, nested). */
function tagged(type: ts.Type, parts: ts.Type[], tag: string, hint: string, exclude: readonly string[]): string {
  const key = `tagged:${parts.map(typeKey).sort().join(',')}:${exclude.join(',')}`;
  if (named.has(key)) return named.get(key)!;
  const name = unique(ownName(type) ?? hint);
  named.set(key, name);
  const groups = new Map<string | boolean, ts.Type[]>();
  for (const t of parts) {
    const v = tagOf(t, tag)!;
    groups.set(v, [...(groups.get(v) ?? []), t]);
  }
  const without = [...exclude, tag];
  const cases: { value: string | boolean; caseName: string; payload: string | null }[] = [];
  for (const [value, group] of [...groups].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const caseName = typeof value === 'boolean' ? (value ? camel(tag) : camel(`not ${tag}`)) : camel(value);
    const payloadName = `${name}${pascal(typeof value === 'boolean' ? caseName : value)}`;
    const payload =
      group.length > 1
        ? (() => {
            const inner = discriminant(group);
            if (!inner) return warn(type, payloadName, `members tagged ${tag}=${value} with nothing else to tell them apart`);
            return tagged(checker.getUnionType(group), group, inner, payloadName, without);
          })()
        : props(group[0]!).some((p) => !without.includes(p.getName()))
          ? struct(group[0]!, payloadName, without)
          : null;
    cases.push({ value, caseName: ident(caseName), payload });
  }
  const tagType = typeof cases[0]!.value === 'boolean' ? 'Bool' : 'String';
  const lit = (v: string | boolean) => (typeof v === 'boolean' ? String(v) : JSON.stringify(v));
  declarations.push(
    [
      `public enum ${name}: Codable, Equatable, Sendable {`,
      ...cases.map((c) => `  case ${c.caseName}${c.payload ? `(${c.payload})` : ''}`),
      '',
      `  private enum Tag: String, CodingKey { case tag = ${JSON.stringify(tag)} }`,
      '',
      '  public init(from decoder: Decoder) throws {',
      '    let container = try decoder.container(keyedBy: Tag.self)',
      `    switch try container.decode(${tagType}.self, forKey: .tag) {`,
      ...cases.map((c) => `    case ${lit(c.value)}: self = .${c.caseName.replace(/`/g, '')}${c.payload ? `(try ${c.payload}(from: decoder))` : ''}`),
      `    case let other: throw DecodingError.dataCorruptedError(forKey: .tag, in: container, debugDescription: "${name}: no case \\(other)")`,
      '    }',
      '  }',
      '',
      '  public func encode(to encoder: Encoder) throws {',
      '    var container = encoder.container(keyedBy: Tag.self)',
      '    switch self {',
      ...cases.map((c) =>
        c.payload
          ? `    case .${c.caseName.replace(/`/g, '')}(let value):\n      try container.encode(${lit(c.value)}, forKey: .tag)\n      try value.encode(to: encoder)`
          : `    case .${c.caseName.replace(/`/g, '')}:\n      try container.encode(${lit(c.value)}, forKey: .tag)`,
      ),
      '    }',
      '  }',
      '}',
    ].join('\n'),
  );
  return name;
}

/** A union of different kinds of value (a seat or 'spectator'): each kind tried in turn when decoding. */
function mixed(type: ts.Type, parts: ts.Type[], hint: string): string {
  const key = `mixed:${parts.map(typeKey).sort().join(',')}`;
  if (named.has(key)) return named.get(key)!;
  const name = unique(ownName(type) ?? hint);
  named.set(key, name);
  const literals = parts.filter((t) => stringLiteral(t) !== null).map((t) => stringLiteral(t)!);
  const rest = parts.filter((t) => stringLiteral(t) === null);
  const numbers = rest.filter((t) => t.flags & (ts.TypeFlags.NumberLiteral | ts.TypeFlags.Number));
  const strings = rest.filter((t) => t.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral));
  const arrays = rest.filter(isArray);
  const objects = rest.filter((t) => isObject(t) && !isArray(t));
  const cases: { name: string; type: string | null; decode: string; encode: string }[] = [];
  for (const v of literals) {
    const c = ident(camel(v));
    cases.push({ name: c, type: null, decode: `if let s = try? container.decode(String.self), s == ${JSON.stringify(v)} { self = .${c.replace(/`/g, '')}; return }`, encode: `case .${c.replace(/`/g, '')}: try container.encode(${JSON.stringify(v)})` });
  }
  if (numbers.length) {
    const t = numbers.every((n) => n.flags & ts.TypeFlags.NumberLiteral) ? 'Int' : 'Double';
    cases.push({ name: 'number', type: t, decode: `if let v = try? container.decode(${t}.self) { self = .number(v); return }`, encode: 'case .number(let v): try container.encode(v)' });
  }
  if (strings.length) cases.push({ name: 'string', type: 'String', decode: 'if let v = try? container.decode(String.self) { self = .string(v); return }', encode: 'case .string(let v): try container.encode(v)' });
  if (arrays.length === 1) {
    const t = swift(arrays[0]!, `${name}Items`);
    cases.push({ name: 'items', type: t, decode: `if let v = try? container.decode(${t}.self) { self = .items(v); return }`, encode: 'case .items(let v): try container.encode(v)' });
  }
  if (objects.length === 1) {
    const t = swift(objects[0]!, `${name}Object`);
    cases.push({ name: 'object', type: t, decode: `if let v = try? container.decode(${t}.self) { self = .object(v); return }`, encode: 'case .object(let v): try container.encode(v)' });
  }
  if (cases.length !== parts.length && !(numbers.length > 1 && cases.length === parts.length - numbers.length + 1)) {
    warnings.push(`${name}: some of ${checker.typeToString(type)} has no case`);
  }
  declarations.push(
    [
      `public enum ${name}: Codable, Equatable, Sendable {`,
      ...cases.map((c) => `  case ${c.name}${c.type ? `(${c.type})` : ''}`),
      '',
      '  public init(from decoder: Decoder) throws {',
      '    let container = try decoder.singleValueContainer()',
      ...cases.map((c) => `    ${c.decode}`),
      `    throw DecodingError.dataCorruptedError(in: container, debugDescription: "${name}: none of its kinds")`,
      '  }',
      '',
      '  public func encode(to encoder: Encoder) throws {',
      '    var container = encoder.singleValueContainer()',
      '    switch self {',
      ...cases.map((c) => `    ${c.encode}`),
      '    }',
      '  }',
      '}',
    ].join('\n'),
  );
  return name;
}

/** An object type: a struct, its fields in order, with Codable that keeps absent and null apart. */
function struct(t: ts.Type, hint: string, exclude: readonly string[], preferred: string | null = null): string {
  const key = `struct:${typeKey(t)}:${exclude.join(',')}`;
  if (named.has(key)) return named.get(key)!;
  const name = unique(exclude.length === 0 ? (ownName(t) ?? preferred ?? hint) : hint);
  named.set(key, name);
  const fields = props(t)
    .filter((p) => !exclude.includes(p.getName()))
    .map((p) => {
      const pt = propType(p);
      const json = p.getName();
      const isOptional = optional(p);
      const nullable = members(pt).some((m) => m.flags & ts.TypeFlags.Null);
      const type = swift(pt, `${name}${pascal(json)}`, [], declaredName(p));
      return { json, swiftName: ident(camel(json)), plain: camel(json), type, isOptional, nullable };
    });
  // Absent and null both possible: Nullable<T>, optional (absent: nil; null: .null).
  const fieldType = (f: (typeof fields)[number]) => (f.isOptional && f.nullable ? `Nullable<${f.type}>` : f.type);
  const field = (f: (typeof fields)[number]) => `  public var ${f.swiftName}: ${fieldType(f)}${f.isOptional || f.nullable ? '?' : ''}`;
  const keys = fields.length ? ['  private enum CodingKeys: String, CodingKey {', ...fields.map((f) => `    case ${f.swiftName}${f.plain === f.json ? '' : ` = ${JSON.stringify(f.json)}`}`), '  }'] : [];
  const decode = fields.map((f) =>
    f.isOptional && f.nullable
      ? `    ${f.plain} = container.contains(.${f.plain}) ? try container.decode(Nullable<${f.type}>.self, forKey: .${f.plain}) : nil`
      : f.isOptional
      ? `    ${f.plain} = try container.decodeIfPresent(${f.type}.self, forKey: .${f.plain})`
      : f.nullable
        ? `    ${f.plain} = try container.decode(${f.type}?.self, forKey: .${f.plain})`
        : `    ${f.plain} = try container.decode(${f.type}.self, forKey: .${f.plain})`,
  );
  const encode = fields.map((f) =>
    f.isOptional
      ? `    try container.encodeIfPresent(${f.plain}, forKey: .${f.plain})`
      : f.nullable
        ? `    if let value = ${f.plain} { try container.encode(value, forKey: .${f.plain}) } else { try container.encodeNil(forKey: .${f.plain}) }`
        : `    try container.encode(${f.plain}, forKey: .${f.plain})`,
  );
  declarations.push(
    [
      `public struct ${name}: Codable, Equatable, Sendable {`,
      ...fields.map(field),
      '',
      `  public init(${fields.map((f) => `${f.plain}: ${fieldType(f)}${f.isOptional || f.nullable ? '? = nil' : ''}`).join(', ')}) {`,
      ...fields.map((f) => `    self.${f.plain} = ${f.plain}`),
      '  }',
      ...(fields.length
        ? [
            '',
            ...keys,
            '',
            '  public init(from decoder: Decoder) throws {',
            '    let container = try decoder.container(keyedBy: CodingKeys.self)',
            ...decode,
            '  }',
            '',
            '  public func encode(to encoder: Encoder) throws {',
            '    var container = encoder.container(keyedBy: CodingKeys.self)',
            ...encode,
            '  }',
          ]
        : ['', '  public init(from decoder: Decoder) throws {}', '', '  public func encode(to encoder: Encoder) throws {}']),
      '}',
    ].join('\n'),
  );
  return name;
}

// ---- the file -----------------------------------------------------------------------------------------------------------

for (const root of ROOTS) {
  const symbol = exports.find((s) => s.getName() === root);
  if (!symbol) throw new Error(`ios/core/bridge.ts exports no ${root}`);
  swift(checker.getDeclaredTypeOfSymbol(symbol), root);
}

const NULLABLE = `/// A field that can be absent, null or a value (\`x?: T | null\`): optional in its struct, nil when absent.
public enum Nullable<Wrapped: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
  case null
  case value(Wrapped)

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    self = container.decodeNil() ? .null : .value(try container.decode(Wrapped.self))
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .value(let v): try container.encode(v)
    }
  }

  /// The value, nil if null.
  public var value: Wrapped? {
    if case .value(let v) = self { return v }
    return nil
  }
}`;

const JSON_VALUE = `/// Any JSON (for what the types don't say more precisely of).
public enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { self = .null }
    else if let v = try? container.decode(Bool.self) { self = .bool(v) }
    else if let v = try? container.decode(Double.self) { self = .number(v) }
    else if let v = try? container.decode(String.self) { self = .string(v) }
    else if let v = try? container.decode([JSONValue].self) { self = .array(v) }
    else { self = .object(try container.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let v): try container.encode(v)
    case .number(let v): try container.encode(v)
    case .string(let v): try container.encode(v)
    case .array(let v): try container.encode(v)
    case .object(let v): try container.encode(v)
    }
  }
}`;

const text = [
  '// Generated by ios/tools/swift-types/generate.ts from the TypeScript types (ios/core/bridge.ts: FromApp, ToApp): do not',
  '// edit. Run it again after changing them; ios/Tests checks that every message the core sends decodes and encodes back.',
  'import Foundation',
  '',
  ...declarations.sort((a, b) => (a.match(/(?:struct|enum) (\w+)/)?.[1] ?? '').localeCompare(b.match(/(?:struct|enum) (\w+)/)?.[1] ?? '')),
  NULLABLE,
  JSON_VALUE,
  '',
].join('\n\n');

for (const w of warnings) console.warn(`warning: ${w}`);
if (process.argv.includes('--check')) {
  const now = readFileSync(OUT, 'utf8');
  if (now !== text) {
    console.error('ios/Shared/Protocol.swift is not what the TypeScript types make now: run node ios/tools/swift-types/generate.ts');
    process.exit(1);
  }
  console.log('ios/Shared/Protocol.swift is up to date');
} else {
  writeFileSync(OUT, text);
  console.log(`ios/Shared/Protocol.swift: ${declarations.length} types${warnings.length ? `, ${warnings.length} warnings` : ''}`);
}
