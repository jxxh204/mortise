import {defineConfig} from 'vite';
import rsc from '@vitejs/plugin-rsc';
import {fileURLToPath} from 'node:url';
import mortise from '../../packages/vite-plugin/src/index';
const source=(p:string)=>fileURLToPath(new URL(p,import.meta.url));
export default defineConfig({root:source('.'),plugins:[mortise({rsc:true,transport:'http'}),rsc({entries:{rsc:source('src/entry.rsc.tsx'),ssr:source('src/entry.ssr.tsx'),client:source('src/entry.browser.tsx')}})],resolve:{alias:[
{find:/^@mortise\/rsc\/server$/,replacement:source('../../packages/rsc/src/server.ts')},
{find:/^@mortise\/rsc\/client$/,replacement:source('../../packages/rsc/src/client.tsx')},
{find:/^@mortise\/server\/node$/,replacement:source('../../packages/server/src/node.ts')},
{find:/^@mortise\/server$/,replacement:source('../../packages/server/src/index.ts')},
{find:'@mortise/core',replacement:source('../../packages/core/src/index.ts')},
{find:'@mortise/react',replacement:source('../../packages/react/src/index.tsx')},
]},server:{host:'127.0.0.1',port:8772,strictPort:true}});
