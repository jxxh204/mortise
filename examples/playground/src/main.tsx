import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DomainProvider, Each, useDomain } from '@mortise/react';
import { cart, booking } from 'mortise:domains';
import CartQuantity from 'mortise:ui/cart/Quantity';
import BookingQuantity from 'mortise:ui/booking/Quantity';
import './style.css';
function Total() { const total = useDomain((state: any) => state.total); return <div className="total">합계 <strong>{Number(total).toLocaleString()}원</strong></div>; }
const errorFallback = (error: Error) => <p role="alert">{error.message}</p>;
function App() {
    const [showOther, setShowOther] = useState(false);
    return <main>
  <header><span className="mark">▦</span> mortise <small>v0.2 / real server transport</small></header>
  <h1>UI는 그대로.<br /><em>실행은 서버에서.</em></h1>
  <p className="intro">계약·UI 자동 연결을 유지하면서 조회와 변경은 HTTP로 서버에 전달합니다.</p>
  <div className="notice">Query·Action은 Node에서 실행됩니다. 새로고침 후에도 값이 유지되며 서버를 재시작하면 초기화됩니다. 익명 데모 정책이며 실제 사용자 로그인·RSC는 아직 없습니다.</div>
  <div className="grid">
   <section><div className="label">CART / SERVER REPOSITORY</div><h2>장바구니</h2>
    <DomainProvider domain={cart} input={{ cartId: 'cart-main' }} fallback={<p>서버 조회 중…</p>} errorFallback={errorFallback}>
     <Each scope="items"><CartQuantity label="상품 수량"/></Each><Total />
    </DomainProvider>
   </section>
   <section><div className="label">BOOKING / SAME UI CONTRACT</div><h2>예약 인원</h2>
    <DomainProvider domain={booking} fallback={<p>서버 조회 중…</p>} errorFallback={errorFallback}><BookingQuantity label="예약 인원"/></DomainProvider>
    <p>동일한 Quantity 소스에 예약 도메인을 연결했습니다. 잘못된 수량 버튼은 서버 검증 오류를 확인합니다.</p>
   </section>
  </div>
  <button className="toggle" onClick={() => setShowOther(v => !v)}>{showOther ? '독립 장바구니 닫기' : '별도 장바구니 열기'}</button>
  {showOther && <section><h2>다른 장바구니 · cart-other</h2><DomainProvider domain={cart} input={{ cartId: 'cart-other' }} fallback={<p>서버 조회 중…</p>} errorFallback={errorFallback}><Each scope="items"><CartQuantity label="다른 상품 수량"/></Each><Total /></DomainProvider></section>}
  <footer>Browser → HTTP → 서버 검증·저장 → Query 재조회 → 계약 구독 갱신<br />브라우저 번들에는 Query·Action·저장소 구현이 포함되지 않습니다.</footer>
 </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
