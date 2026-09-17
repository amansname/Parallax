import { Linter } from 'eslint';
import { posix } from 'node:path';

// Workers do not inherit the document's import map. Bind literal module
// references in the immutable artifact, using ESLint's existing JS parser.
// Application source remains native ES modules; no bundler or new dependency.
export function versionModuleImports(sourceBytes, modulePath, artifactId, modulePaths) {
  const source = Buffer.from(sourceBytes).toString('utf8');
  const replacements = [];
  const available = new Set(modulePaths);
  const visit = node => {
    const reference = node.source;
    if (reference?.type !== 'Literal' || typeof reference.value !== 'string') return;
    const specifier = reference.value;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return;
    const resolved = new URL(specifier, `https://artifact.invalid/${modulePath}`);
    const target = decodeURIComponent(resolved.pathname.slice(1));
    if (!available.has(target)) throw new Error(`${modulePath} imports a non-artifact module: ${specifier}`);
    if (resolved.searchParams.has('v') && resolved.searchParams.get('v') !== artifactId) {
      throw new Error(`${modulePath} imports another artifact version: ${specifier}`);
    }
    resolved.searchParams.set('v', artifactId);
    const relative = posix.relative(posix.dirname(modulePath), target);
    const versioned = `${relative.startsWith('.') ? relative : `./${relative}`}${resolved.search}${resolved.hash}`;
    replacements.push({ start: reference.range[0], end: reference.range[1], value: JSON.stringify(versioned) });
  };
  const messages = new Linter().verify(source, [{
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { artifact: { rules: { imports: { create: () => ({
      ImportDeclaration: visit,
      ExportNamedDeclaration: visit,
      ExportAllDeclaration: visit,
      ImportExpression: visit,
    }) } } } },
    rules: { 'artifact/imports': 'error' },
  }]);
  const parseError = messages.find(message => message.fatal);
  if (parseError) throw new Error(`Cannot parse artifact module ${modulePath}:${parseError.line}: ${parseError.message}`);
  return Buffer.from(replacements.sort((a, b) => b.start - a.start).reduce(
    (text, replacement) => text.slice(0, replacement.start) + replacement.value + text.slice(replacement.end),
    source,
  ));
}
