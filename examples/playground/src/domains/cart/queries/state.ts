import { defineQuery, schema } from '@mortise/core';
export default defineQuery({ input: schema.object({ cartId: schema.string() }), async run(input, ctx) { return ctx.services.cart.get(input.cartId); } });
