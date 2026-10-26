# 구조와 실행 흐름

Mortise는 React를 렌더러로 사용한다. v0.2의 HTTP 실행 계층 위에 v0.3은 실험적 RSC 렌더링과 초기 스냅샷 bridge를 추가한다. 기존 HTTP 예제는 Client 렌더링을 유지하고, 별도 RSC 예제는 실제 Flight 스트림을 사용한다. 독립 배포된 서버 사이의 RSC 조립은 포함하지 않는다.

## 책임 경계

| 패키지 | 책임 |
| --- | --- |
| `@mortise/core` | 스키마, 계약 정의, 도메인 제공 선언, 발견한 Query·Action 연결, 상태 projection 검증 |
| `@mortise/react` | 도메인·항목 실행 범위, 조회와 명령 상태, 계약 구독과 React UI 연결 |
| `@mortise/server` | HTTP 요청 검사, 요청별 컨텍스트, 권한 콜백, 서버 Query·Action 실행 |
| `@mortise/rsc/server` | AsyncLocalStorage 기반 요청 scope와 `readDomain`, `readDomainInput` |
| `@mortise/rsc/client` | RSC payload를 표시하는 `RscRoot`와 새 스냅샷을 반환하는 refresh bridge |
| Vite 플러그인 | 도메인 파일 발견, 가상 도메인 모듈 생성, 계약을 요구하는 UI의 wrapper 생성 |
| 애플리케이션 | 업무 데이터와 규칙, 외부 API 호출, 화면 배치, 오류 표현 |

## 계약 참여와 자동 연결

계약은 `id`, `version`, 상태 멤버 스키마, 명령의 입력·출력 스키마를 가진다. 도메인은 `provides`에 계약을 명시적으로 등록한다. 등록한 계약 안에서만 같은 이름의 상태와 Action을 기본 연결한다.

`provide`의 `state`와 `commands`는 별칭 맵이다. 전체 연결을 다시 작성하는 설정이 아니다. 선언하지 않은 멤버는 같은 이름을 사용한다. 예를 들어 `quantity: 'guests'`는 UI의 `quantity`를 도메인의 `guests`에서 읽게 한다.

`defineDomain`은 중복 제공과 존재하지 않는 계약 멤버의 override를 검사한다. `attachDomain`은 발견한 Query·Action을 결합하고 필요한 명령 구현이 있는지 검사한다. `projectState`는 실제 데이터에 필드가 있는지 확인하고 계약 스키마로 검사한다. 따라서 설정 검사와 실제 데이터 검사는 서로 다른 시점에 일어난다.

## 세 가지 범위

1. **소스 범위:** UI 파일의 위치로 도메인을 찾는다. UI 코드는 특정 도메인 구현보다 계약에 의존한다.
2. **도메인 인스턴스:** `DomainProvider`가 현재 데이터 입력과 실행 환경을 제공한다. 같은 계약을 사용해도 다른 인스턴스의 상태를 임의로 공유하지 않는다.
3. **항목 범위:** `Each`가 collection과 안정적인 항목 키를 선택한다. 계약에 collection scope를 선언했다면 UI도 해당 항목 범위에서 실행되어야 한다.

폴더는 특정 상품을 선택할 수 없다. 도메인의 `items` 중 어떤 상품인지 결정하는 것은 실행 중인 항목 범위다. 배열 인덱스를 영속적인 상품 식별자로 취급하지 않는다.

## UI가 받는 것

UI는 계약에 투영된 읽기 전용 상태와 명령 호출 인터페이스를 받는다. 서버 모델 객체나 저장소를 직접 받지 않는다. 명령 실행 상태는 업무 상태와 분리한다.

계약의 상태·명령 타입은 TypeScript에서 추론할 수 있다. 하지만 현재의 문자열 alias와 실행 컨텍스트는 전체 도메인 데이터 모델까지 정적으로 검증하는 시스템이 아니다. UI의 타입 추론이 곧 모든 연결의 빌드 시 검증을 뜻하지 않는다.

## 변경 이후의 화면 갱신

```text
사용자 입력
  → 계약 명령 호출
  → HTTP 요청 전송
  → 서버의 요청·권한·계약 입력 검사
  → 서버에서 최신 Query를 실행해 대상 항목 확인
  → 연결된 Action 실행
  → 결과 검증 및 응답
  → 클라이언트가 조회 갱신 요청
  → 계약 상태 재계산
  → React UI 갱신
```

업무 규칙은 Action이나 Model에 남긴다. 이름 매칭은 `setQuantity`를 찾을 수 있지만 구매 제한, 권한, 재고, 인원 제한을 추론할 수는 없다.

조회 및 mutation의 기반은 TanStack Query 5다. 일반 HTTP 예제는 JSON Query 갱신을 사용한다. RSC 예제는 Action 이후 `onRefresh`로 Flight 트리를 다시 받고 같은 응답의 스냅샷을 Client 상태에 적용한다.

## RSC의 세 실행 환경

공식 Vite RSC 플러그인의 구분을 따른다. HTML 문자열만 서버에서 생성하는 것을 RSC라고 부르지 않는다.

```text
rsc 환경
  서버 Query → 스냅샷
  runWithDomain → Server Component 실행 → Flight 스트림
                                          ├─ ssr 환경: Flight 해석 → HTML
                                          └─ client 환경: Flight 해석 → hydration
```

`examples/rsc/src/entry.rsc.tsx`는 스냅샷을 한 번 조회한 뒤 `{ root, snapshot }`을 Flight로 직렬화한다. `/index.rsc`는 `text/x-component`로 응답하고, `/`는 이 스트림을 SSR 환경으로 전달한다. SSR은 스트림을 나누어 HTML 렌더와 hydration payload 주입에 사용한다. 브라우저는 주입된 payload를 해석하고 `hydrateRoot`로 기존 HTML에 연결한다.

RSC 요청 scope는 `runWithDomain` 내부에서 실제 `renderToReadableStream`을 시작해 구성한다. 비동기 Server Component는 `await` 이후에도 `readDomain`으로 같은 scope를 읽는다. `readDomain`은 서버 전용 스냅샷 접근이며 React Context나 브라우저 구독 Hook이 아니다. 현재 API는 한 요청 렌더의 단일 도메인 스냅샷을 다룬다.

### 스냅샷 bridge와 갱신

`DomainProvider`는 `initialState`, `revision`, `onRefresh`를 선택적으로 받는다. 초기 상태가 있으면 서버 HTML과 Client 첫 렌더에 같은 데이터를 사용하고 초기 재조회를 생략한다. 이후 더 큰 revision의 스냅샷만 받아들이며 기존 UI를 의도적으로 remount하지 않는다.

`RscRoot`의 `load(revision)`은 새 `{ root, snapshot }`을 요청한다. `useRscRefresh`는 이를 `DomainProvider.onRefresh`에 연결한다. 명령의 pending은 refresh 결과를 처리할 때까지 유지된다. 다만 Flight root의 React transition과 TanStack Query 캐시 반영은 별도 경로이므로 원자적인 단일 commit을 보장하지 않는다.

revision은 Client의 응답 순서 추적값이다. 서버 저장소의 버전, 다중 사용자 충돌 감지, 분산 일관성 장치가 아니다.

## HTTP 모드의 빌드 경계

Vite 플러그인의 `transport: 'http'`는 브라우저의 `mortise:domains`를 `createRemoteDomain` 기반 호출 프록시로 생성한다. Query·Action 구현 대신 도메인 정의와 계약, 요청 코드가 브라우저에 들어간다. 서버의 실제 도메인은 Query·Action 구현을 연결해 `createMortiseHandler`에 등록한다.

개발 모드에서는 `serverEntry`를 통해 Vite 서버에 핸들러를 연결한다. 프로덕션 예제는 Node 서버에서 정적 클라이언트 파일과 RPC를 함께 제공한다. UI wrapper만으로 서버 경계를 만드는 것은 아니다.

`domain.ts`와 계약은 브라우저에 전달되는 선언이므로 비밀 정보나 서버 구현을 import하지 않아야 한다. 공개 계약 바깥의 서버 함수가 요청 이름만으로 실행되지 않도록 서버에서도 계약·명령 등록을 확인한다.

`mortise({ rsc: true })`는 공식 플러그인의 실제 `rsc` 환경에서만 `ui/server`를 허용한다. `ui/client`에는 Client 경계를 선언한다. 서버 UI가 SSR 또는 브라우저 환경에서 직접 실행되도록 import되면 오류다. SSR 환경은 RSC 결과와 Client 참조를 해석하는 역할을 맡는다.

## 서버가 신뢰하는 값

브라우저의 도메인 입력과 항목 키는 조회·변경 대상을 요청하는 값이지 권한의 증거가 아니다. `context`는 요청에서 신뢰할 수 있는 실행 환경을 만들고, 필수 `authorize` 콜백은 요청 허용 여부를 판단한다. 실제 데이터 소유권과 업무 규칙은 애플리케이션에서 검사한다.

서버 Action의 `root`와 `scope.value`는 서버가 조회한 최신 스냅샷에서 얻는다. 브라우저가 보낸 전체 상태 객체를 그대로 신뢰하지 않는다. 다만 조회 후 Action 실행 사이의 경쟁은 여전히 가능하므로 저장 시점의 원자적 검사와 트랜잭션은 저장소 구현이 책임진다.

## 객체지향 원칙을 적용하는 방식

- **캡슐화:** 공개 계약을 통해 필요한 데이터와 명령만 노출한다.
- **의존성 역전:** UI는 장바구니·예약 클래스 대신 `QuantityEditable` 계약에 의존한다.
- **대체 가능성:** 같은 계약의 명령은 같은 의미를 지켜야 한다. 타입 일치만으로 의미를 검증할 수는 없다.
- **응집도:** 각 도메인의 업무 규칙과 API 연결은 그 도메인에 둔다.

이 원칙을 따르기 위해 모든 파일을 클래스로 만들 필요는 없다. 작은 기능은 함수, 스키마, 기본 규약으로 작성하고, 데이터 형태가 다를 때 alias를 추가한다.

## 기반 문서

세 환경과 Flight 처리의 기준은 [공식 Vite RSC 플러그인](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-rsc/README.md)을 따른다. 초기 HTML과 Client 렌더의 일치는 [React hydrateRoot](https://react.dev/reference/react-dom/client/hydrateRoot)의 요구사항이다. Mortise의 scope·계약·refresh bridge는 이 기반 위에 추가한 실험적 구현이다.
