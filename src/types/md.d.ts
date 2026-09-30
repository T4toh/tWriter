// `angular.json` carga los `.md` como texto (`"loader": { ".md": "text" }`):
// la chuleta de rayas (`docs/raya.md`) es la misma para la app y para la wiki.
declare module '*.md' {
  const content: string;
  export default content;
}
