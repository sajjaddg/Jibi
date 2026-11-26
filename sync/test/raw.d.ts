/** Vite's `?raw` import — a file's text — for the schema dumps in test/schemas. */
declare module '*?raw' {
  const text: string;
  export default text;
}
