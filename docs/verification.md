# v0.2 검증 결과

- 전체 55개 테스트 통과: core 7, React 9, Vite 플러그인 11, Fetch RPC 24, 실제 HTTP Node 어댑터 4.
- 전체 TypeScript 검사 및 core/react/vite-plugin/server 패키지 빌드 통과.
- Client production bundle 및 Node server bundle 빌드 통과.
- 개발 서버 8770 및 프로덕션 서버 8771에서 scripts/verify-http.mjs 통과: 조회, 항목 명령, 서버 합계, 잘못된 수량, Origin 거부, 권한 거부, 명령 allowlist, 정적 페이지.
- 실제 브라우저: 수량 1→2와 합계 70,000→120,000원, 새로고침 후 서버 값 유지, 수량 11에 대한 서버 오류 확인.
- Client 산출물에서 서버 저장소 sentinel·서버 Action 오류 문구가 제외됨을 확인. 플러그인 테스트는 간접 서버 import도 차단.
- Client-only 번들에서는 use client 지시어가 무시된다는 Rollup 경고가 남음. RSC 빌드가 아니며 RSC 지원을 의미하지 않음.

## 실행

pnpm install 후 pnpm dev.
또는 pnpm build 이후 pnpm start.
개발 http://127.0.0.1:8770, 프로덕션 http://127.0.0.1:8771.

## 한계

- RSC 렌더링, 실제 사용자 인증, 영속 DB, 원격 컴포넌트 배포 미구현.
- 예제는 명시적 익명 접근 정책과 서버 프로세스 메모리를 사용한다.
- scope 조회와 저장 사이 원자성은 실제 저장소의 transaction/revision 검사로 해결해야 한다.
- Query 반환 전체가 브라우저에 전달되므로 공개 가능한 데이터만 반환해야 한다.
- 로컬 UI 인스턴스 간 자동 캐시 공유·동기화는 미구현.


# v0.3 RSC 검증

- 전체 테스트 66개 통과: core 7, React 15, 플러그인 15, Fetch RPC 24, Node HTTP 4, RSC 요청 scope 1.
- TypeScript 검사, 전체 패키지·기존 HTTP 예제 빌드, RSC/SSR/Client 세 환경 빌드 통과.
- scripts/verify-rsc.mjs: text/x-component Flight, async 서버 합계의 초기 HTML 포함, 서버 변경 후 새 렌더, 서로 다른 장바구니 동시 요청의 scope 격리, Client 번들에서 서버 구현 제외를 확인.
- 빌드 미리보기 8773 브라우저: 수량 1→2, 서버 상품 목록 1개→2개, RSC 합계 70,000→120,000원 갱신 확인. 관찰한 콘솔에 앱 hydration 복구 오류는 없었음(브라우저 확장 경고는 별개).
- 초기 RSC payload와 Client 캐시는 같은 조회 스냅샷을 사용함. 브리지 테스트에서는 초기 브라우저 Query 0과 SSR→hydrate 오류 0을 확인.
- RSC 트리와 캐시 반영의 원자적 React commit, 여러 도메인 조합, 실제 사용자 인증, 영속 DB, 독립 원격 컴포넌트 배포는 아직 미구현.
- start:rsc는 Vite의 빌드 미리보기이며 운영 서버·배포 제품의 완성을 의미하지 않음.
