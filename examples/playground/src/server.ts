import { createMortiseHandler, MortiseHttpError } from '@mortise/server';
import domains from 'mortise:server-domains';
import { services } from './server-services';
export default createMortiseHandler({
    domains,
    context() { return { services, principal: { kind: 'demo' } }; },
    authorize(_request, _context, operation) {
        // Explicit anonymous demo policy, NOT a real login or ownership system.
        if (operation.domain === 'cart') {
            const id = (operation.input as {
                cartId?: unknown;
            } | undefined)?.cartId;
            if (id !== 'cart-main' && id !== 'cart-other')
                throw new MortiseHttpError(403, 'FORBIDDEN', '이 장바구니에 접근할 수 없습니다.');
        }
        else if (operation.domain !== 'booking')
            throw new MortiseHttpError(403, 'FORBIDDEN', '지원하지 않는 도메인입니다.');
    },
});
