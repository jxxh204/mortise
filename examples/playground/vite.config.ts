import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import mortise from '../../packages/vite-plugin/src/index';
const source=(path:string)=>fileURLToPath(new URL(path,import.meta.url));
export default defineConfig({
  root:source('.'),
  plugins:[mortise({transport:'http',serverEntry:'src/server.ts',publicOrigin:'http://127.0.0.1:8770'})],
  resolve:{alias:[
    {find:/^@mortise\/server\/node$/,replacement:source('../../packages/server/src/node.ts')},
    {find:/^@mortise\/server$/,replacement:source('../../packages/server/src/index.ts')},
    {find:'@mortise/core',replacement:source('../../packages/core/src/index.ts')},
    {find:'@mortise/react',replacement:source('../../packages/react/src/index.tsx')},
  ]},
  server:{host:'127.0.0.1',port:8770,strictPort:true},
  build:{outDir:'dist',emptyOutDir:true},
});
