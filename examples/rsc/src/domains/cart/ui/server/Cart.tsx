import React from 'react';
import {readDomain} from '@mortise/rsc/server';
import CartBridge from '../client/CartBridge';
import type {DomainSnapshot} from '@mortise/react';
type CartState={id:string;items:{id:string;name:string;quantity:number}[];total:number};
async function ServerSummary(){await Promise.resolve();const cart=readDomain<CartState>();return <div className="total" data-testid="server-total">RSC 서버 합계 <strong>{cart.total.toLocaleString()}원</strong></div>;}
export default async function Cart({snapshot}:{snapshot:DomainSnapshot}){const cart=readDomain<CartState>();return <main><header>▦ mortise <small>v0.3 / real React Server Components</small></header><h1>서버에서 그리고,<br/><em>계약으로 연결한다.</em></h1><div className="notice">실제 RSC Flight 스트림 → SSR HTML → hydration. 목록·합계는 서버 컴포넌트, 수량 버튼은 Client 컴포넌트입니다.</div><section data-cart-id={cart.id}><div className="label">SERVER COMPONENT / ASYNC QUERY</div><h2>장바구니</h2><p data-testid="server-items">{cart.items.map(i=>`${i.name} ${i.quantity}개`).join(' · ')}</p><CartBridge snapshot={snapshot}><ServerSummary/></CartBridge></section><footer>같은 서버 스냅샷으로 렌더링·hydrate합니다. 변경 후 새 RSC 스트림을 받습니다.<br/>RSC·Client의 원자적 commit, 실제 로그인·영속 DB·원격 배포는 후속 과제입니다.</footer></main>;}
