import React from 'react';
import {createFromReadableStream,getClientEntryUrl} from '@vitejs/plugin-rsc/ssr';
import {renderToReadableStream} from 'react-dom/server.edge';
import {injectRSCPayload} from 'rsc-html-stream/server';
import {RscRoot,type RscPayload} from '@mortise/rsc/client';
export async function renderHTML(stream:ReadableStream<Uint8Array>){const [renderStream,hydrateStream]=stream.tee();let promise:Promise<RscPayload>|undefined;function Root(){promise??=createFromReadableStream<RscPayload>(renderStream);return <RscRoot initialPayload={React.use(promise)}/>;}const html=await renderToReadableStream(<html lang="ko"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Mortise RSC</title></head><body><div id="root"><Root/></div></body></html>,{bootstrapScriptContent:`import(${JSON.stringify(getClientEntryUrl())})`});return html.pipeThrough(injectRSCPayload(hydrateStream));}
