# Mortise

React UI가 요구하는 계약을 선언하면 도메인의 상태와 Action을 연결하는 프레임워크 프로토타입이다. 같은 이름은 자동으로 연결하고, 다른 이름만 `domain.ts`에 적는다.

v0.2는 **계약 기반 UI 연결과 실제 HTTP Query·Action 실행**을 제공한다. UI는 브라우저에서 React로 렌더링하고, Query·Action은 Node 서버에서 실행한다. RSC, 인증된 사용자 시스템, 원격 컴포넌트 배포는 아직 지원하지 않는다. 예제 데이터는 서버 프로세스 메모리에 저장된다. 자세한 범위는 [제약 문서](docs/limitations.md)를 참고한다.

## 실행

저장소 루트에서 실행한다. Node.js 20.19 이상과 pnpm이 필요하다. 저장소의 `packageManager` 필드에 pnpm 버전이 지정되어 있다.

```sh
pnpm install
pnpm generate
pnpm dev
```

개발 예제는 `http://127.0.0.1:8770`에서 열린다. Origin 검사가 있으므로 설정된 주소를 사용한다.

타입 검사, 테스트, 빌드:

```sh
pnpm generate
pnpm typecheck
pnpm test
pnpm build
```

프로덕션 예제는 빌드한 뒤 별도 Node 서버로 실행한다.

```sh
pnpm build
pnpm start
```

기본 프로덕션 주소는 `http://127.0.0.1:8771`이다. 외부 주소를 변경할 때는 `MORTISE_ORIGIN`을 설정한다. 이 값은 서버의 허용 origin과 예제의 listen 주소에도 사용되므로 배포 환경에 맞게 지정한다.

`pnpm generate`는 발견한 도메인과 UI의 공개 import 타입을 생성한다. UI 파일을 추가하거나 이름을 바꾼 뒤 타입 검사를 할 때 다시 실행한다.

Playground의 Vite 설정은 이미 플러그인을 연결한다. 별도 앱에서 사용할 때의 플러그인 진입점은 다음과 같다. 이 저장소의 패키지를 빌드해 연결해야 하며, npm에 배포된 패키지라는 의미는 아니다.

```ts
import { defineConfig } from "vite";
import mortise from "@mortise/vite-plugin";

export default defineConfig({
  plugins: [mortise({
    domainsDir: "src/domains",
    transport: "http",
    serverEntry: "src/server.ts",
  })],
});
```

## 작성 위치

```text
src/
├── contracts/
│   └── quantity-editable.ts
└── domains/
    ├── cart/
    │   ├── domain.ts
    │   ├── queries/state.ts
    │   ├── actions/setQuantity.ts
    │   └── ui/client/Quantity.tsx
    └── booking/
        ├── domain.ts
        ├── queries/state.ts
        ├── actions/changeGuestCount.ts
        └── ui/client/Quantity.tsx
```

`domain.ts`는 제공할 계약을 정한다. `queries/state.ts`는 기본 상태를 조회한다. `actions/*.ts`의 파일명은 기본 명령 이름이다. `ui/client`에는 계약을 사용하는 Client UI를 작성한다. UI의 배치 순서와 조건은 JSX로 작성한다.

## 1. UI가 요구하는 계약

```ts
// src/contracts/quantity-editable.ts
import { defineCapability, schema } from "@mortise/core";

export const QuantityEditable = defineCapability({
  id: "quantity-editable",
  version: 1,
  state: {
    quantity: schema.integer(),
    min: schema.integer(),
    max: schema.integer(),
  },
  commands: {
    setQuantity: {
      input: schema.integer(),
      output: schema.void(),
    },
  },
});
```

`setQuantity(3)`은 수량을 3으로 지정한다는 의미다. 장바구니와 예약 모두 이 의미를 지켜야 한다. 스키마는 데이터 형태를 검사하지만 명령의 업무 의미까지 증명하지 않는다.

## 2. 같은 이름은 자동 연결

```ts
// src/domains/cart/domain.ts
import { defineDomain, provide } from "@mortise/core";
import { QuantityEditable } from "../../contracts/quantity-editable";

export default defineDomain({
  provides: [provide(QuantityEditable, { scope: "items" })],
});
```

장바구니의 기본 상태가 `items: [{ id, quantity, min, max }]`를 반환하면 각 항목을 계약에 연결한다. 항목 키의 기본값은 `id`다. `actions/setQuantity.ts`는 같은 이름의 명령에 자동 연결된다.

단일 객체인 기본 상태에 연결하고 이름도 모두 같다면 `provides: [QuantityEditable]`만 작성할 수 있다.

## 3. 다른 이름만 지정

```ts
// src/domains/booking/domain.ts
import { defineDomain, provide } from "@mortise/core";
import { QuantityEditable } from "../../contracts/quantity-editable";

export default defineDomain({
  provides: [
    provide(QuantityEditable, {
      state: {
        quantity: "guests",
        min: "minimumGuests",
        max: "maximumGuests",
      },
      commands: { setQuantity: "changeGuestCount" },
    }),
  ],
});
```

예약은 `guests`, `minimumGuests`, `maximumGuests`를 반환하는 Query와 `actions/changeGuestCount.ts`를 제공한다. 선언하지 않은 계약 멤버는 같은 이름으로 연결한다. 계약에 참여하지 않은 도메인에서 비슷한 필드를 찾아 연결하지 않는다.

## 4. Query와 Action 작성

```ts
// src/domains/cart/queries/state.ts
import { defineQuery, schema } from "@mortise/core";

export default defineQuery({
  input: schema.object({ cartId: schema.string() }),
  run(input, ctx) {
    return ctx.services.cart.get(input.cartId);
  },
});
```

```ts
// src/domains/cart/actions/setQuantity.ts
import { defineAction, schema } from "@mortise/core";
import { MortiseHttpError } from "@mortise/server";

export default defineAction({
  input: schema.integer(),
  async run(next, ctx) {
    if (!ctx.scope) throw new MortiseHttpError(400, "ITEM_REQUIRED", "상품 범위가 필요합니다.");
    const item = ctx.scope.value;
    if (next < item.min || next > item.max) {
      throw new MortiseHttpError(422, "QUANTITY_LIMIT", "허용된 수량 범위를 벗어났습니다.");
    }
    await ctx.services.cart.setQuantity(ctx.root.id, ctx.scope.key, next);
  },
});
```

`services`는 서버의 요청 컨텍스트가 제공하는 구현이다. 이 예시의 `cart.get`와 `cart.setQuantity`도 애플리케이션에서 작성해야 한다. HTTP 모드에서 브라우저는 이 구현을 import하지 않고 생성된 요청 프록시를 사용한다. 로컬 모드도 있으므로 함수 이름만으로 서버 실행이 보장되지는 않는다.

Query 결과 전체가 클라이언트에 전달되므로 공개 가능한 데이터만 반환한다. 계약이 화면에서 사용하는 필드를 제한하더라도 Query 응답에서 비밀 필드를 자동 제거하지는 않는다.

## 5. UI는 계약을 통해 주입받는다

```tsx
// src/domains/cart/ui/client/Quantity.tsx
import type { UI } from "@mortise/react";
import { QuantityEditable } from "../../../../contracts/quantity-editable";

export default function Quantity({
  state,
  commands,
}: UI<typeof QuantityEditable>) {
  const change = commands.setQuantity;

  return (
    <div>
      <button
        disabled={change.pending || state.quantity <= state.min}
        onClick={() => void change.execute(state.quantity - 1)}
      >−</button>
      <span>{state.quantity}</span>
      <button
        disabled={change.pending || state.quantity >= state.max}
        onClick={() => void change.execute(state.quantity + 1)}
      >+</button>
      {change.error && <p role="alert">{change.error.message}</p>}
    </div>
  );
}
```

Vite 플러그인은 이 함수에 계약을 구독하는 wrapper를 생성한다. UI가 직접 Provider를 만들거나 계약 데이터를 props로 전달받도록 부모들을 수정할 필요가 없다.

계약은 실제 실행에서도 필요하므로 **값 import**로 가져온다. `UI` 타입만 `import type`으로 가져온다. 현재 변환 대상은 위처럼 매개변수 하나에 `UI<typeof Contract, Props>`를 붙인 `export default function`이다. 화살표 함수, async 함수, generic UI 함수는 지원하지 않는다.

개별 UI 입력이 필요하면 두 번째 타입 인자와 `props`를 사용한다.

```tsx
type Props = { label: string };

export default function Quantity({ state, props }: UI<typeof QuantityEditable, Props>) {
  return <span>{props.label}: {state.quantity}</span>;
}
```

## 6. 공개 UI 진입점으로 배치

```tsx
import { DomainProvider, Each } from "@mortise/react";
import { cart } from "mortise:domains";
import Quantity from "mortise:ui/cart/Quantity";

export function CartScreen() {
  return (
    <DomainProvider
      domain={cart}
      input={{ cartId: "cart-main" }}
      fallback={<p>불러오는 중…</p>}
      errorFallback={(error) => <p role="alert">{error.message}</p>}
    >
      <Each scope="items">
        <Quantity />
      </Each>
    </DomainProvider>
  );
}
```

예약은 루트 상태에 계약을 제공하므로 `Each` 없이 해당 `DomainProvider` 안에 배치한다. UI의 구현을 예약 폴더로 옮겨도 계약 소비 코드는 같다. 여러 항목 중 어느 것을 다룰지는 폴더가 아니라 `Each`의 실행 범위가 정한다.

HTTP 모드에서는 브라우저의 `services` props로 서버 서비스를 전달하지 않는다. `input`은 서버 Query의 입력이며, 위의 `cartId`는 데모의 데이터 선택자다. 사용자의 소유권이나 인증을 증명하는 값이 아니다.

## 7. 서버에서 요청을 실행한다

`@mortise/server`의 `createMortiseHandler`는 실제 Query·Action을 연결한 도메인 등록부, 요청별 `context`, 필수 `authorize` 콜백을 받는다. 기본 엔드포인트는 `POST /_mortise/query`와 `POST /_mortise/command`다.

```ts
// src/server.ts — 서버 전용 진입점
import { createMortiseHandler } from "@mortise/server";
import domains from "mortise:server-domains";
import { createContext, authorize } from "./server/access";

export default createMortiseHandler({
  domains,
  context: createContext,
  authorize,
});
```

이 예시의 `createContext`와 `authorize`는 애플리케이션에서 작성하는 함수다. 전자는 요청별 서비스와 사용자 정보를 만들고, 후자는 `(request, context, operation)`을 받아 허용하지 않는 요청에 예외를 던진다. `authorize`의 `operation.input`은 아직 Query 스키마로 검사하기 전의 요청 값이므로 형태를 확인해서 사용한다. `mortise:server-domains`는 서버 빌드에서만 사용할 수 있다.

```text
브라우저 UI
  → createRemoteDomain이 생성한 HTTP 프록시
  → 서버: 요청 검사와 authorize
  → 서버: 최신 Query 결과로 항목 범위 확인
  → 서버: Action 실행과 결과 검사
  → 브라우저: 재조회 후 상태 갱신
```

서버는 클라이언트가 보낸 `root`나 항목 상태를 신뢰하지 않는다. 항목 키로 서버의 최신 조회 결과에서 대상을 찾는다. 그래도 조회와 저장 사이의 경쟁, 실제 소유권, 재고 같은 업무 규칙은 Action과 저장소에서 검증해야 한다.

예제는 이 HTTP 경로를 보여주지만 로그인 시스템은 아니다. 운영 서비스는 요청의 세션·토큰에서 사용자를 확인하고 `authorize`와 업무 Action에서 접근을 검사해야 한다. Origin 검사와 계약 타입은 인증을 대신하지 않는다.

Vite middleware는 개발 서버에서만 실행한다. 프로덕션에서는 별도 Node 서버가 정적 클라이언트 파일과 RPC를 제공해야 한다. 프록시 뒤에 배포하는 경우 Node 어댑터의 `publicOrigin`을 사용자가 실제 접근하는 주소로 설정한다.

**TypeScript 주의:** 원본 `Quantity.tsx`의 함수 타입에는 주입되는 `state`, `commands`, `props`가 보인다. JSX 사용처에서는 원본 파일을 직접 import하지 않고 `mortise:ui/cart/Quantity` 같은 생성된 공개 진입점을 사용한다. 생성 타입은 외부 `Props`만 요구한다. 생성된 선언 파일이 앱의 TypeScript 검사 대상에 포함되어야 한다.

## 자동으로 처리하는 것

- 도메인, 기본 Query, Action 파일 발견과 가상 import 생성
- 명시적으로 제공한 계약의 같은 이름 연결과 다른 이름의 alias
- 계약 상태와 명령 입력·출력 검사
- 도메인·항목별 상태 접근과 명령의 pending/error 제공
- 같은 도메인 인스턴스의 명령 순차 처리와 변경 후 조회 갱신
- UI wrapper 생성과 공개 UI 타입 생성
- HTTP 모드의 Query·Action 요청 프록시와 서버 요청·계약 검사

업무 규칙, 외부 API 구현, UI 배치, 실제 서버 인증·권한은 애플리케이션의 책임이다. 폴더와 계약 이름으로 이를 추측하지 않는다.

## 설계와 한계

- [아키텍처](docs/architecture.md): 계약, 소스 범위, 도메인 인스턴스, 항목 범위의 관계
- [지원 범위와 제약](docs/limitations.md): RSC 미지원, 타입 검사 범위, 서버 메모리 데모와 인증·영속성의 차이

이 저장소의 API는 초기 구현이며, 이전 대화에서 제안한 모든 API와 호환되는 확정 명세가 아니다. 실제 export와 예제 코드를 기준으로 사용한다.

실행 가능한 예제는 [Playground](examples/playground/src/main.tsx), [장바구니 도메인](examples/playground/src/domains/cart/domain.ts), [예약 도메인](examples/playground/src/domains/booking/domain.ts)에 있다.
