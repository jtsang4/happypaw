/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

interface Window {
  __HAPPYPAW_HASH_ROUTER__?: boolean;
}
