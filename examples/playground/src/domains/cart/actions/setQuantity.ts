import { defineAction, schema } from '@mortise/core';
import { MortiseHttpError } from '@mortise/server';
export default defineAction({ input: schema.integer(), async run(next, ctx) {
        const item = ctx.scope?.value;
        if (!item || next < item.min || next > item.max)
            throw new MortiseHttpError(422, 'QUANTITY_LIMIT', '수량은 1~10개여야 합니다.');
        await ctx.services.cart.setQuantity(ctx.root.id, ctx.scope!.key, next);
    } });
