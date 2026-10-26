import React from 'react';
import {DomainProvider,Each,type DomainSnapshot} from '@mortise/react';
import {useRscRefresh} from '@mortise/rsc/client';
import {cart} from 'mortise:domains';
import Quantity from 'mortise:ui/cart/Quantity';
export default function CartBridge({snapshot,children}:{snapshot:DomainSnapshot;children:React.ReactNode}){const refresh=useRscRefresh();return <DomainProvider domain={cart} input={{cartId:(snapshot.state as {id:string}).id}} initialState={snapshot.state} revision={snapshot.revision} onRefresh={refresh}><Each scope="items"><Quantity label="상품 수량"/></Each>{children}</DomainProvider>;}
