/** Vite's `?raw` import — a file's text. */
declare module '*?raw' {
  const text: string;
  export default text;
}

/** Vite's `import.meta.glob`, eager form only — for test/vectors. */
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
}
