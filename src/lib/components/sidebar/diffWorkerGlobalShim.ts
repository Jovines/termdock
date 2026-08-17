// refractor@2's pre-bundled CJS calls `capture()` at module scope, which
// touches the Node `global` binding; that binding does not exist in browser
// or worker realms when the dev server serves the dep without a shim.
// Imported for side effects BEFORE refractor in the diff worker entry.
if (!('global' in globalThis)) {
  (globalThis as { global?: typeof globalThis }).global = globalThis;
}
