// Vite's `?raw` import suffix. Used by the structural coverage tests, which assert on real source
// TEXT: these tests run inside workerd, which has no filesystem, so the file is inlined at build
// time instead of read at runtime.
//
// Its own file rather than a block in `env.d.ts`, which has top-level imports and is therefore a
// MODULE — a `declare module` there is an augmentation of an existing module, not the ambient
// wildcard declaration this needs to be.
declare module '*?raw' {
  const content: string
  export default content
}
