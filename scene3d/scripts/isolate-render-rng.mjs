import path from 'node:path';
import { parse } from 'acorn';
import MagicString from 'magic-string';
import { assert, sha256 } from './artifact-utils.mjs';

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);
function children(node) {
  const result = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) { for (const child of value) if (child?.type) result.push([child, key]); }
    else if (value?.type) result.push([value, key]);
  }
  return result;
}
function analyze(code, label, { isolateAnimationContext = false } = {}) {
  let ast;
  try { ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
  catch (error) { throw new Error(`RNG AST parse failed (${label}): ${error.message}`); }
  const scopes = new WeakMap(), bindings = new WeakSet(), parents = new WeakMap();
  function bind(pattern, scope) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') { scope.names.add(pattern.name); bindings.add(pattern); }
    else if (pattern.type === 'RestElement') bind(pattern.argument, scope);
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left, scope);
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(item => bind(item, scope));
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(item => bind(item.type === 'RestElement' ? item.argument : item.value, scope));
  }
  function visit(node, scope, parent, key) {
    if (parent) parents.set(node, { parent, key });
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') bind(node.id, scope);
    if (/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
      scope = { parent: scope, names: new Set(), function: true };
      if (node.type === 'FunctionExpression') bind(node.id, scope);
      node.params.forEach(item => bind(item, scope));
    } else if (['BlockStatement', 'CatchClause', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'ClassExpression', 'ClassDeclaration', 'SwitchStatement'].includes(node.type)) {
      scope = { parent: scope, names: new Set(), function: false };
      if (node.type === 'CatchClause') bind(node.param, scope);
      if (node.type.startsWith('Class')) bind(node.id, scope);
    }
    scopes.set(node, scope);
    if (node.type === 'VariableDeclaration') {
      let target = scope;
      if (node.kind === 'var') while (target.parent && !target.function) target = target.parent;
      node.declarations.forEach(item => bind(item.id, target));
    }
    if (node.type === 'ImportDeclaration') node.specifiers.forEach(item => bind(item.local, scope));
    for (const [child, childKey] of children(node)) visit(child, scope, node, childKey);
  }
  visit(ast, { names: new Set(), parent: null, function: true });
  function reference(node) {
    if (node.type !== 'Identifier' || bindings.has(node)) return false;
    const { parent, key } = parents.get(node) || {};
    if (!parent) return true;
    if ((parent.type === 'MemberExpression' || parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition') && key === 'property' && !parent.computed) return false;
    if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent.type) && key === 'key' && !parent.computed) return false;
    if (/^Import/.test(parent.type) || (parent.type === 'ExportSpecifier' && key === 'exported')) return false;
    if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && key === 'label') return false;
    return true;
  }
  function globalRef(node, name) {
    if (!node || node.type !== 'Identifier' || node.name !== name || !reference(node)) return false;
    for (let scope = scopes.get(node); scope; scope = scope.parent) if (scope.names.has(name)) return false;
    return true;
  }
  function property(node) {
    if (!node.computed) return node.property.name;
    return node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null;
  }
  function isGlobalObject(node) { return node?.type === 'Identifier' && GLOBAL_OBJECTS.has(node.name) && globalRef(node, node.name); }
  function isMath(node) {
    return globalRef(node, 'Math') || (node?.type === 'MemberExpression' && isGlobalObject(node.object) && property(node) === 'Math');
  }
  const randomNodes = [], animationContextNodes = [];
  function reject(node, reason) { throw new Error(`RNG isolation rejected ${label}:${node.start}: ${reason}`); }
  function inspect(node) {
    const relation = parents.get(node), parent = relation?.parent;
    if (node.type === 'ImportExpression' && (node.source.type !== 'Literal' || typeof node.source.value !== 'string')) reject(node, 'dynamic module URL cannot be statically audited');
    if (isGlobalObject(node)) {
      // Reviewed Three WebGLAnimation consumes only these two scheduling capabilities.
      // Do not let its normal setContext(self) hand an unauditable global alias to another function.
      if (isolateAnimationContext && node.name === 'self' && parent?.type === 'CallExpression' && parent.arguments.length === 1 && parent.arguments[0] === node && parent.callee.type === 'MemberExpression' && parent.callee.object.type === 'Identifier' && parent.callee.object.name === 'animation' && property(parent.callee) === 'setContext') {
        animationContextNodes.push(node); return;
      }
      if (!(parent?.type === 'MemberExpression' && parent.object === node) && !(parent?.type === 'UnaryExpression' && parent.operator === 'typeof')) reject(node, 'global object alias cannot be statically audited');
      if (parent?.type === 'MemberExpression') {
        const name = property(parent);
        if (name === null || GLOBAL_OBJECTS.has(name) || ['eval', 'Function'].includes(name)) reject(parent, 'dynamic/global alias access');
      }
    }
    if (globalRef(node, 'eval') || globalRef(node, 'Function')) reject(node, 'dynamic code execution');
    if (node.type === 'MemberExpression' && property(node) === 'Math' && !isGlobalObject(node.object)) reject(node, 'indirect Math namespace access');
    if (isMath(node)) {
      if (!(parent?.type === 'MemberExpression' && parent.object === node)) reject(node, 'Math alias/escape cannot be statically audited');
      const name = property(parent);
      if (name === null || ['constructor', '__proto__'].includes(name)) reject(parent, 'dynamic Math access');
      if (name === 'random') {
        const use = parents.get(parent)?.parent;
        if ((use?.type === 'AssignmentExpression' && use.left === parent) || use?.type === 'UpdateExpression' || (use?.type === 'UnaryExpression' && use.operator === 'delete')) reject(parent, 'writing global random is prohibited');
        randomNodes.push(parent);
      }
    }
    for (const [child] of children(node)) inspect(child);
  }
  inspect(ast);
  return { ast, randomNodes, animationContextNodes };
}
export function auditRenderRng(code, label = 'artifact') {
  const result = analyze(code, label);
  assert(result.randomNodes.length === 0, `Unisolated Math.random in ${label}`);
  return { audited: true, unisolatedReferences: 0 };
}
function isolateDracoWorkerSource(code, id) {
  if (!/\/node_modules\/three\/examples\/jsm\/loaders\/DRACOLoader\.js$/.test(id.replaceAll('\\', '/'))) return null;
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const workers = ast.body.filter(node => node.type === 'FunctionDeclaration' && node.id.name === 'DRACOWorker');
  assert(workers.length === 1, 'Reviewed Three DRACOWorker boundary changed');
  const worker = workers[0]; let references = 0;
  function inspect(node, parent, grandparent) {
    if (node === worker) return;
    if (node.type === 'Identifier' && node.name === 'DRACOWorker') {
      assert(parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.name === 'toString' && grandparent?.type === 'CallExpression' && grandparent.callee === parent && grandparent.arguments.length === 0, 'DRACOWorker must only be serialized, never executed in host realm');
      references++;
    }
    for (const [child] of children(node)) inspect(child, node, parent);
  }
  inspect(ast); assert(references === 1, 'Reviewed Three worker serialization count changed');
  const source = code.slice(worker.start, worker.end), text = new MagicString(code);
  // Three only calls .toString() then extracts this function body for a Blob Worker.
  // A string gives exactly the same serialization, without leaving worker-only dynamic
  // self[typedArrayName] accesses executable in the host module's AST.
  text.overwrite(worker.start, worker.end, `const DRACOWorker = ${JSON.stringify(source)};`);
  return { code: text.toString(), registration: { source: 'three/examples/jsm/loaders/DRACOLoader.js#DRACOWorker', realm: 'worker', sha256: sha256(source), bytes: Buffer.byteLength(source) } };
}
export function transformRenderRng(code, id, helperImport) {
  const worker = isolateDracoWorkerSource(code, id);
  if (worker) code = worker.code;
  const reviewedThreeAnimation = /\/node_modules\/three\/(?:build\/three\.module\.js|src\/renderers\/WebGLRenderer\.js)$/.test(id.replaceAll('\\', '/'));
  const { randomNodes, animationContextNodes } = analyze(code, id, { isolateAnimationContext: reviewedThreeAnimation });
  if (!randomNodes.length && !animationContextNodes.length && !worker) return null;
  let local = '__scene3dRenderRandom';
  while (new RegExp(`\\b${local}\\b`).test(code)) local += '_';
  const text = new MagicString(code);
  for (const node of randomNodes) text.overwrite(node.start, node.end, local);
  for (const node of animationContextNodes) text.overwrite(node.start, node.end, '({ requestAnimationFrame: callback => self.requestAnimationFrame(callback), cancelAnimationFrame: handle => self.cancelAnimationFrame(handle) })');
  const statement = randomNodes.length ? `import { renderRandom as ${local} } from ${JSON.stringify(helperImport)};\n` : '';
  if (code.startsWith('#!')) text.appendLeft(code.indexOf('\n') + 1, statement); else text.prepend(statement);
  return { code: text.toString(), map: worker ? null : text.generateMap({ hires: true }), replacements: randomNodes.length, animationContexts: animationContextNodes.length, registeredWorkers: worker ? [worker.registration] : [] };
}
export function isolateRenderRng({ projectRoot, helperPath = path.join(projectRoot, 'scene3d', 'src', 'render-random.js') }) {
  const normalizedHelper = helperPath.replaceAll('\\', '/');
  const transformed = [], workers = [];
  return {
    name: 'scene3d-isolate-render-rng', enforce: 'pre',
    transform(code, id) {
      const clean = id.split('?')[0].replaceAll('\\', '/');
      if (clean === normalizedHelper) { auditRenderRng(code, id); return null; }
      if (id.startsWith('\0') || !/\.[cm]?js$/.test(clean)) return null;
      // Vite's complete browser module graph, including every transitive dependency.
      const output = transformRenderRng(code, id, normalizedHelper);
      if (output) { transformed.push({ id: clean, replacements: output.replacements, animationContexts: output.animationContexts }); workers.push(...output.registeredWorkers); }
      return output;
    },
    generateBundle(_options, bundle) {
      for (const [name, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') {
          assert([...output.imports, ...output.dynamicImports].every(item => Object.hasOwn(bundle, item)), `External browser dependency prohibited: ${name}`);
          auditRenderRng(output.code, name);
        }
      }
    },
    api: { transformed, workers }
  };
}
